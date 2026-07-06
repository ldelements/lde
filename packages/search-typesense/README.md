# @lde/search-typesense

[Typesense](https://typesense.org/) engine adapter for the engine- and
domain-agnostic [`@lde/search`](../search) core. **Engine-specific (Typesense) but
domain-agnostic** – you supply a `SearchType`; this package never names your
domain. It is the Typesense implementation of the `SearchEngine` port: it derives
a collection schema from the field model, compiles the neutral `SearchQuery` into
Typesense search params, runs it, reconstructs the engine-neutral `SearchResult`,
and manages the search index lifecycle (blue/green rebuild).

## Collection schema and engine

`buildCollectionSchema(searchType, { name, defaultSortingField, … })` derives a
Typesense collection from the unified `SearchField` model — the Typesense field
type comes from each field’s `kind`, and the physical fanout (per-locale
search/sort keys) matches what the projection writes, via
`@lde/search`’s `physicalFields`, so the index and the documents cannot drift.

`createTypesenseSearchEngine(client, { collection, labelsCollection })` is the
`SearchEngine` implementation. Each search:

- validates the query against the search type (the port contract — a
  structurally invalid query is rejected, never sent);
- compiles it into Typesense search params (`buildSearchParams`);
- runs the search;
- resolves reference (and reference-facet) labels from the sidecar `labels`
  collection in a single lookup;
- reconstructs the logical `SearchResult` (`parseSearchResponse`) — language
  maps, labelled references, labelled facet buckets.

`searchFacets` – the port’s batch entry point – answers a whole batch of
facet-only queries (e.g. a faceted sidebar’s skip-own-filter variants) as a
**single `multi_search` round-trip**, with one bundled label lookup shared by
every facet result in the batch. A failed entry is reported in place as a
per-query outcome, so its siblings’ facets survive.

The pure halves `buildSearchParams` and `parseSearchResponse` are exported for
direct use and testing.

## Indexing

`rebuild` blue/green-rebuilds a search index in one call, straight from the
declaration: it derives the collection schema from your `SearchType` (via
`buildCollectionSchema`), creates a fresh versioned collection
(`${name}_<timestamp>`), streams the documents into it in batches, atomically
repoints the `name` alias to it, then drops the collection it superseded. The
caller passes the `SearchType`, the logical index `name` and a stream of
documents; the versioned collection and the alias are managed for them.

```ts
import { Client } from 'typesense';
import { rebuild } from '@lde/search-typesense';

const client = new Client({
  nodes: [{ host, port, protocol: 'https' }],
  apiKey,
});

// `documents` is an async iterable (e.g. a streaming projection); only one
// batch is held in memory at a time. `rebuild` returns the live collection name
// and the imported count (or `null` if another rebuild was already running).
const result = await rebuild(client, documents, DATASET, { name: 'datasets' });
```

The options accept everything `buildCollectionSchema` does (`defaultLocale`,
`defaultSortingField`, `synonymSets`) plus the rebuild knobs (`batchSize`,
`lockTtlMs`).

`rebuild` takes a `Client` the caller owns (and reuses for queries), so this
package adds no connection or document type of its own – any object with an `id`
is a valid document, including the `SearchDocument`s `@lde/search` produces.

## Concurrency

`rebuild` is **single-flight per index**: it first takes a lock (a marker
document in a `rebuild_locks` collection, created on demand) via Typesense’s
atomic create, so concurrent callers across pods never rebuild the same index at
once. A call made while another rebuild for that index is in flight returns
`null` instead of a count. This keeps blue/green safe under replication: without
it, two same-millisecond rebuilds would collide on the versioned collection name
and one would delete the other’s in-flight build.

Limitations to design around:

- **Advisory, not a strict mutex.** The lock is built on Typesense, not a
  consensus store. Under a TTL-reclaim race two rebuilds can briefly run at
  once; this is safe because blue/green is idempotent (worst case: redundant
  work and a transient orphaned collection).
- **Single-flight, not coalescing.** A call skipped with `null` is _not_ queued.
  If you must capture state that changed mid-build, re-trigger after the running
  rebuild finishes.
- **Lock TTL.** A rebuild running longer than `lockTtlMs` (default 10 minutes)
  can be reclaimed by another caller and run concurrently; size the TTL above
  your longest rebuild.
