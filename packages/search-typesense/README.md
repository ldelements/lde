# @lde/search-typesense

[Typesense](https://typesense.org/) engine adapter for the engine- and
domain-agnostic [`@lde/search`](../search) core. **Engine-specific (Typesense) but
domain-agnostic** – you supply a `SearchType`; this package never names your
domain. It is the Typesense implementation of the `SearchEngine` port: it derives
a collection schema from the field model, compiles the neutral `SearchQuery` into
Typesense search params, runs it, reconstructs the engine-neutral `SearchResult`,
and manages the search index lifecycle as transactional `@lde/pipeline`
writers (Blue/green Rebuild and In-place Rebuild).

## Collection schema and engine

`buildCollectionSchema(searchType, { name, defaultSortingField, … })` derives a
Typesense collection from the unified `SearchField` model — the Typesense field
type comes from each field’s `kind`, and the physical fanout (per-locale
search/sort keys) matches what the projection writes, via
`@lde/search`’s `physicalFields`, so the index and the documents cannot drift.

**Memory lever.** Typesense keeps the index in RAM (with a raw copy of each
document on disk), so RAM tracks the _indexed_ surface – roughly 2–3× the size
of the fields you search, facet or sort on – not the full document.
`buildCollectionSchema` keeps that surface minimal: the `output` display labels
fan out to `index: false` fields, stored on disk and fetched only for a hit, so
they cost no RAM; only the folded `*_search_${locale}`, facet/reference and
`*_sort_${locale}` companions are indexed. Keeping retrieval-only fields
un-indexed is the lever for holding a large index’s RAM down.

`createTypesenseSearchEngine(client, schema, { collections })` is the
`SearchEngine` implementation. Each search:

- validates the query against the search type (the port contract — a
  structurally invalid query is rejected, never sent);
- compiles it into Typesense search params (`buildSearchParams`);
- runs the search;
- resolves reference (and reference-facet) labels **per reference field**
  from the collection of the `SearchType` its `labelSource` names – all
  sources bundled into a single lookup. A reference without a `labelSource`
  stays id-only. With `labelCacheTtlMs` set, each label-source collection is
  instead loaded once into an in-memory cache;
- reconstructs the logical `SearchResult` (`parseSearchResponse`) — language
  maps, labelled references, labelled facet buckets.

A label source is just another `SearchType` in the schema (with an `output`,
`searchable` text field called `label`) whose collection appears in
`collections` – a typed entity collection and a ‘labels collection’ are the
same kind of thing.

`searchFacets` – the port’s batch entry point – answers a whole batch of
facet-only queries (e.g. a faceted listing’s skip-own-filter variants) as a
**single `multi_search` round-trip**, with one bundled label lookup shared by
every facet result in the batch. A failed entry is reported in place as a
per-query outcome, so its siblings’ facets survive.

The pure halves `buildSearchParams` and `parseSearchResponse` are exported for
direct use and testing.

## Indexing

Indexing runs through two transactional writers, one per update mode – the
[NDE Stack](https://docs.nde.nl/stack/patterns) patterns of the same names:

- [**Blue/green Rebuild**](#bluegreen-rebuild: build a fresh index, then swap to it atomically;
- [**In-place Rebuild**](#in-place-rebuild): update the live index directly by
  upserting changed sources and sweeping the rest.

Both implement `@lde/pipeline`’s `Writer` – each run is
`openRun(context)` → `write` per dataset → `commit()` or `abort(error)` – so
an `@lde/pipeline` `Pipeline` drives them without branching on the mode. Both
derive the collection schema from your `SearchType` (via
`buildCollectionSchema`), and their options accept everything
`buildCollectionSchema` does (`defaultLocale`, `defaultSortingField`,
`synonymSets`) plus the tuning knobs (`batchSize`, `lockTtlMs`).

### Blue/green Rebuild

`BlueGreenRebuild` rebuilds the index from zero and goes live atomically:
`openRun` creates a fresh versioned collection (`${name}_<timestamp>`),
`write` streams documents into it in batches (each stamped with its `source`
dataset IRI), and `commit` atomically repoints the `name` alias and drops the
collection it superseded. Until commit, the live alias never points at a
partial build; `abort` drops the half-built collection. Deletion is implicit –
whatever a run does not write does not exist in the new collection. A dataset
that fails (or is reset before a dump re-run) is rolled back out of the
not-yet-live collection by `source`, so the swap never ships a half-processed
dataset. Right-sized for small collections (e.g. one document per dataset
description).

```ts
import { Client } from 'typesense';
import { BlueGreenRebuild } from '@lde/search-typesense';

const client = new Client({
  nodes: [{ host, port, protocol: 'https' }],
  apiKey,
});

const writer = new BlueGreenRebuild(client, DATASET, { name: 'datasets' });
// Standalone use; under @lde/pipeline the Pipeline drives this lifecycle.
const run = await writer.openRun(context);
await run.write(dataset, documents);
await run.commit();
```

### In-place Rebuild

`InPlaceRebuild` maintains one long-lived collection with per-source
atomicity – no swap, no staging – for large, mostly-static corpora (e.g.
millions of objects across many datasets, where a daily run touches only the
changed ones). Every document is stamped with its `source` (the dataset IRI)
and `last_seen` (the run id); deletion is a sweep, never special-cased:

- a successful dataset flush deletes the source’s documents the run did not
  rewrite (`source = dataset && last_seen != runId`); a failed dataset is not
  swept – its output is incomplete – and the next successful run reconciles;
- `commit` deletes every document whose source left the run’s selection (the
  registry-membership sweep over `RunContext.selectedSources()`, which
  includes datasets skipped as unchanged);
- `abort` only releases the lock: upserts are idempotent, so whatever landed
  stays until the next run reconciles.

Document ids must be unique per (source, entity) – the caller keys them.

Both writers take a `Client` the caller owns (and reuses for queries), so this
package adds no connection or document type of its own – any object with an `id`
is a valid document, including the `SearchDocument`s `@lde/search` produces.

## Concurrency

Rebuilds are **single-flight per index**: `openRun` takes a lock (a marker
document in a `rebuild_locks` collection, created on demand) via Typesense’s
atomic create, so concurrent runs across pods never rebuild the same index at
once – a run opened while another holds the lock throws
`RebuildAlreadyRunning` (catch it to treat a concurrent rebuild as a graceful
skip). This keeps blue/green safe under replication: without it, two
same-millisecond rebuilds would collide on the versioned collection name and
one would delete the other’s in-flight build.

Limitations to design around:

- **Advisory, not a strict mutex.** The lock is built on Typesense, not a
  consensus store. Under a TTL-reclaim race two rebuilds can briefly run at
  once; this is safe because blue/green is idempotent (worst case: redundant
  work and a transient orphaned collection) and in-place upserts are
  idempotent.
- **Single-flight, not coalescing.** A run refused with `RebuildAlreadyRunning`
  is _not_ queued. If you must capture state that changed mid-build,
  re-trigger after the running rebuild finishes.
- **Lock TTL.** A rebuild running longer than `lockTtlMs` (default 10 minutes)
  can be reclaimed by another caller and run concurrently; size the TTL above
  your longest rebuild.
- **Membership-sweep cap.** The in-place membership sweep enumerates distinct
  sources via a single facet, capped at `maxSweepableSources` (default
  10 000); beyond that the commit throws rather than sweeping blind. Raise the
  option (up to the engine’s `max_facet_values` limit) before an index nears
  the cap so it stays a tunable guard rather than a hard wall.
