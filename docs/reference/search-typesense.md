# @lde/search-typesense

[Typesense](https://typesense.org/) engine adapter for the engine- and
domain-agnostic [`@lde/search`](./search) core. **Engine-specific (Typesense) but
domain-agnostic** – you supply a `SearchType`; this package never names your
domain. It is the Typesense implementation of the `SearchEngine` port: it derives
a collection definition from the field model, compiles the neutral `SearchQuery` into
Typesense search params, runs it, reconstructs the engine-neutral `SearchResult`,
and manages the search index lifecycle as transactional `@lde/pipeline`
writers (Blue/green Rebuild and In-place Rebuild).

## Installation

```sh
npm install @lde/search-typesense
```

## Collection naming

You pass `SearchType`s; this package names the collections. `deriveCollectionName`
turns a type’s logical `name` into a Typesense collection name by Typesense’s own
convention – snake_case, named after the plural of what the collection holds, as
its [collection guide](https://typesense.org/docs/guide/organizing-collections.html)
writes them (`people`, `companies`, `blog_articles`):

| `SearchType.name` | collection       |
| ----------------- | ---------------- |
| `Dataset`         | `datasets`       |
| `CreativeWork`    | `creative_works` |
| `Person`          | `people`         |
| `TVSeries`        | `tv_series`      |
| `DCATDataset`     | `dcat_datasets`  |

The writers and the engine all fall back to this one convention, so documents
cannot be written to `creative_works` and queried from `creativeWorks` – and a
reference’s `labelSource` resolves to its label type’s collection the same way.
Every naming input is therefore optional: `buildCollectionDefinition(type)`,
`new BlueGreenRebuild(client, type)`, `createTypesenseSearchEngine(client, schema)`.

Naming lives here rather than in `@lde/search` because it is engine-specific:
Elasticsearch/OpenSearch index names are kebab-case and
[constrained](https://www.elastic.co/guide/en/elasticsearch/reference/current/indices-create-index.html)
(lowercase only, no `\ / * ? " < > | space , #`, no leading `-` `_` `+`, ≤ 255
bytes), so a future `@lde/search-elasticsearch` formats the same neutral tokens
(`@lde/search`’s `physicalNameTokens`) its own way. The core stays engine-neutral.

Pass `collectionNameFor` to **override** the convention – an env prefix, a
multi-tenant name, a collection that already exists, a migration:

```ts
const writer = new BlueGreenRebuild(client, CREATIVE_WORK, {
  collectionNameFor: (type) => `staging_${deriveCollectionName(type)}`,
});
const engine = createTypesenseSearchEngine(client, schema, {
  collections: { CreativeWork: 'staging_creative_works' },
});
writer.collectionName; // 'staging_creative_works' – read-only, for logs/health checks
engine.collectionNameFor(CREATIVE_WORK); // the same name, resolved once at construction
```

It is a function of the type rather than a bare name because a writer names more
than its own collection: a [joinable reference](#joins-across-collections) is
emitted as a Typesense reference field naming its **peer’s** collection, and a
blue/green build has to name the peer’s _fresh_ collection, not its live alias.
One function covers both.

On the read side, `collections` overrides only the types it names; the rest stay
derived.

Everything the convention cannot do, it refuses to guess at, when the writer or
engine is constructed rather than on the first rebuild or search:

- a name it cannot spell (`Café` would quietly become `cafs`) or turn into a
  legal collection name;
- two types whose names **derive to the same collection** – English collapses
  `Medium` and `Media` onto `media`, `Person` and `People` onto `people` – which
  would land both types’ documents in one collection, each search returning the
  other’s. Name either one explicitly to resolve it. Types that share a
  collection _deliberately_ (say, several label sources in one `labels`
  collection) are fine: name both, and it is your call, not an accident.

## Collection schema and engine

`buildCollectionDefinition(searchType, { collectionNameFor?, schema?, defaultSortingField, … })`
derives a Typesense collection from the unified `SearchField` model – the
Typesense field type comes from each field’s `kind`, and the physical fanout
(per-locale search/sort keys, plus one regex display field per output text
field) matches what the projection writes, via `@lde/search`’s `physicalFields`
and its display helpers, so the index and the documents cannot drift.

An **inline reference** is stored as a nested object – `object` or `object[]`,
which turns on the collection’s `enable_nested_fields` – with one nested
Physical Field per field of the type it nests (`media.contentUrl`,
`media.caption_<lang>`, via `nestedFieldName`). A nested field is declared
`index: false` unless it opts into a query capability, so a display-only nesting is
weight on disk like the language labels, and only a `filterable`/`searchable`
one costs memory. Pass the `schema` option for a type that carries one – it is
what resolves the nested type; a type declaring one without it throws here,
rather than building a collection whose documents would all fail to import.

Two consequences of how Typesense stores nesting, both verified against 30.2 and
both handled here rather than left to a caller:

- **The parent object is indexed whenever any descendant is.** An indexed child
  under an `index: false` parent is silently ignored – no error, and every query
  answering empty – so the parent’s flag is computed from its children.
- **A value under a multi-valued ancestor arrives as a list**, however
  single-valued its own declaration. An indexed field’s declared type is checked
  against what is stored, so it is widened (`int64` → `int64[]`); an unindexed
  one is not.

An inline reference declaring `filterable` or `facetable` also emits its
[identity companion](./search#data-on-the-edge) – a flat `${name}_id` field,
faceted in the nested object’s place, since an engine can filter and facet
neither an object nor per array element.

A **reference inheriting a [facet policy](./search#facet-policy)** – a facetable
`lookup`/`labelSource` reference to a type declaring `facetKeys` – is declared
as a plain stored field (`facet: false`) plus a `${name}_facet` companion
(`facet: true`, optional) holding the admitted subset, and the query compiler
facets the companion and filters the field itself with the exact `:=`
operator. Only the `schema` option can resolve the policy: built without it,
the field itself is declared the facet and no companion is – the projection
makes the same reading without a schema – so a deployment declaring a policy
passes the schema to its writers, as `createSearchIndexer` does.

An `InPlaceRebuild` additionally refuses a type whose declared
[dataset field](#provenance) inherits a policy: it enumerates the indexed
datasets by faceting that field, and a facet narrowed to the admitted keys
would hide every dataset the policy excludes from the membership sweep.

### Joins across collections

A reference declaring [`joinable: true`](./search#filtering-across-collections)
is emitted as a Typesense **reference field**, so a query can filter this
collection by a condition on the referenced one:

```json
{
  "name": "publisher",
  "type": "string",
  "reference": "publishers.id",
  "async_reference": true,
  "cascade_delete": false
}
```

All three are forced, none is a knob:

- **`reference` always targets `.id`.** A reference match hitting more than one
  document is a 400, and `id` is the only field the schema guarantees unique.
- **`async_reference: true`.** Without it, a document whose referent has not been
  indexed yet is rejected with a 400 – and the batch import runs
  `throwOnFail: false`, so those would be silently dropped documents. Documents
  stream per dataset, so out-of-order arrival is normal, and the engine
  back-fills the reference when the referent lands.

  ::: warning First build: run the indexer twice
  Back-fill is exact when the two collections are written one after the other,
  but per-type stages write them **concurrently**, and Typesense 30.2 can lose a
  reference written in that window permanently – the documents all land, the
  join just finds nothing. A second run meets referents that already exist, so
  every reference resolves at write time. Steady-state runs over a stable corpus
  are unaffected; a component built from scratch should be indexed twice. See
  [ADR 19](../decisions/0019-filter-across-collections-through-declared-joins#documented-limitations).
  :::

- **`cascade_delete: false`.** It defaults to `true`, so a sweep removing a
  departed source’s `Publisher` documents would delete other sources’
  `CreativeWork` documents with them. Disabling it requires `async_reference`, so
  the two travel together.

A query’s `on` path compiles to one `$collection(…)` wrapper per hop –
`$datasets($publishers(id:=X))` – with the leaf term compiled against the
_target_ type’s declaration, so a date bound one hop out is still stored as Unix
seconds and a facetable keyword still takes the loose membership. The join graph
names the type; `collections` / `collectionNameFor` names the collection.

The `schema` option is required for a type declaring a joinable reference, as it
is for a surfaced inline one – it is what resolves the target.

**Memory lever.** Typesense keeps the index in RAM (with a raw copy of each
document on disk), so RAM tracks the _indexed_ surface – roughly 2–3× the size
of the fields you search, facet or sort on – not the full document.
`buildCollectionDefinition` keeps that surface minimal: the `output` display
labels land in one `index: false` regex field (`${name}_<lang>`, one value per
present language), stored on disk and fetched only for a hit, so they cost no RAM
and preserve every language; only the folded `*_search_${locale}`,
facet/reference and `*_sort_${locale}` companions are indexed. Keeping
retrieval-only fields un-indexed is the lever for holding a large index’s RAM
down.

`createTypesenseSearchEngine(client, schema, { collections? })` is the
`SearchEngine` implementation. Each search:

- validates the query against the search type (the port contract – a
  structurally invalid query is rejected, never sent);
- compiles it into Typesense search params (`buildSearchParams`);
- runs the search;
- resolves reference (and reference-facet) labels **per reference field**
  from the collection of the `SearchType` its `labelSource` names – all
  sources bundled into a single lookup. A reference without a `labelSource`
  stays id-only. With `labelCacheTtlMs` set, each label-source collection is
  instead loaded once into an in-memory cache;
- reconstructs the logical `SearchResult` (`parseSearchResponse`) – language
  maps, labelled references, labelled facet buckets, and one nested Search
  Document per referent of a surfaced inline reference (each referent’s values
  grouped, `id` only where the referent had one). Nesting is rebuilt here,
  below every API surface, so a second surface inherits it rather than
  reimplementing it.

A label source is just another `SearchType` in the schema (with an `output`,
`searchable` text field under its
[`labelField`](./search#naming-the-label-field) name, `label` by default), so
its collection is named by the same
convention as any other type’s – a typed entity collection and a ‘labels
collection’ are the same kind of thing.

`searchFacets` – the port’s batch entry point – answers a whole batch of
facet-only queries (e.g. a faceted listing’s skip-own-filter variants) as a
**single `multi_search` round-trip**, with one bundled label lookup shared by
every facet result in the batch. A failed entry is reported in place as a
per-query outcome, so its siblings’ facets survive.

**Every query travels as a `multi_search` POST** – the root search included, not
just the facet batch and the label lookup. Typesense’s per-collection search
endpoint is a GET, so a long `filter_by` (a batch [lookup by
IRI](./search#lookup-by-iri), or any membership over many IRIs, which URL-encode
to several times their length) would overflow its 4000-character query-string
limit. In the POST body the filter is bounded by the request instead. Because
`multi_search` reports a failure as an inline entry rather than rejecting, the
adapter translates a failed root entry back into a throw: `search()` still
rejects on engine failure.

The pure halves `buildSearchParams` and `parseSearchResponse` are exported for
direct use and testing.

### Engine options

Beyond `collections`, `TypesenseSearchEngineOptions` carries:

- **`maxFacetValues`** – the cap on buckets returned per facet
  (`max_facet_values`). Left unset, **Typesense defaults to 10**, so a
  high-cardinality facet (publisher, keyword) silently truncates to its top
  ten buckets; a deployment with such facets must raise it. Range facets
  return one bucket per declared range regardless, but a value larger than
  the range count is still safe.
- **`onLabelError`** – called when reference-label resolution fails; the
  search then degrades to id-only references (and reference-facet buckets to
  unlabelled ones) rather than failing. Omit it and the degradation is
  silent, so supply it to log the cause.
- **`onIgnoredFilter`** – called for each `where` clause that compiles to
  nothing and is skipped: an empty `in` list, a `range` with no usable bound
  (through the engine, a structurally invalid clause throws up front instead,
  so only the vacuous ones reach this). Omit it and the skip is silent.
- **`labelCacheTtlMs`** – opt-in in-memory label cache. When set, each
  label-source collection is exported **in full** once (the documents export
  endpoint) and held in memory for the process lifetime, refreshed after the
  TTL; each search then resolves labels by in-memory lookup instead of a
  per-search `multi_search` round-trip. Loads are single-flight (concurrent
  first searches share one export), and a **failed load is not cached** – it
  degrades that search to id-only and the next search retries. Size it
  against the label collections’ total size, which the process holds
  resident.

## Indexing

Indexing runs through two transactional writers, one per update mode – the
[NDE Stack](https://docs.nde.nl/stack/patterns) patterns of the same names:

- [**Blue/green Rebuild**](#bluegreen-rebuild): build a fresh index, then swap to
  it atomically;
- [**In-place Rebuild**](#in-place-rebuild): update the live index directly by
  upserting changed sources and sweeping the rest.

Both implement `@lde/pipeline`’s `Writer` – each run is
`openRun(context)` → `write` per dataset → `commit()` or `abort(error)` – so
an `@lde/pipeline` `Pipeline` drives them without branching on the mode. Both
derive the collection definition from your `SearchType` (via
`buildCollectionDefinition`), and their options accept everything
`buildCollectionDefinition` does (`defaultLocale` – the stemming locale for
untagged `und` text, see [Locales](./search#locales) – plus
`defaultSortingField` and `synonymSets`) and the tuning knobs: `batchSize`
(documents imported per Typesense request, default 1000) and `lockTtlMs`.

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

// The collection is named from the type: `Dataset` → `datasets`.
const writer = new BlueGreenRebuild(client, DATASET);
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
- `reset` (the pipeline’s dump-fallback discard) deletes only **this run’s**
  writes for the source (`source = dataset && last_seen = runId`), so the dump
  re-run rebuilds it cleanly while the source’s prior-run documents are left
  for the success sweep to reconcile;
- `commit` deletes every document whose source left the run’s selection (the
  registry-membership sweep over `RunContext.selectedSources()`, which
  includes datasets skipped as unchanged);
- `abort` only releases the lock: upserts are idempotent, so whatever landed
  stays until the next run reconciles.

Document ids must be unique per (source, entity) – the caller keys them.

`openRun` creates the collection on demand and otherwise leaves an existing one
alone – with one exception. If the collection exists but does not carry every
[reference field](#joins-across-collections) the declaration asks for (a
`joinable` added to a schema whose index predates it), or every
[facet companion](#collection-schema-and-engine) its facets read (a `facetKeys`
policy added to a type this one references), the run **fails** at open – after
the lock, before any write – naming the drop-and-rebuild that fixes it. Without
that it would index and commit happily and then fail on every join query, or
on every facet over that reference: the values would be there, the reference
or the facet field would not. Rotating a pipeline version reprocesses datasets;
it does not recreate collections. Scoped to those two – every other schema
difference is self-correcting.

### The join component is the unit of rebuild

Types connected by a [joinable reference](#joins-across-collections) form a
**join component**, and a component rebuilds as a unit. `searchIndexWriter`
([`@lde/search-pipeline`](./search-pipeline)) opens the runs in join order,
referenced first – an engine cannot create a collection whose reference names
one that does not exist yet – and commits per component, referrers first, so a
blue/green build never drops a collection the still-live referrer points at. The
first failure stops the rest of its component from going live, and the abort
that follows **abandons** that component’s uncommitted collections rather than
dropping them – dropping one would delete exactly what the member that did
commit now references, while abandoning keeps it and still releases the rebuild
lock, so the next run is not locked out.

Two consequences worth planning for:

- a type with **no** joinable reference is a singleton component and behaves
  exactly as it did: its collection still commits, sweeps and fails in
  isolation. The coupling is opt-in, per edge;
- blue/green has a brief inconsistency window at the alias flip. Typesense
  stores the concrete collection name in a reference and re-resolves the alias
  at query time, and there is no atomic multi-alias swap, so a join query can see
  `400 Failed to join on …` for one round trip.

### Provenance

`source` above is the **private** bookkeeping field a writer adds when the
`SearchType` declares nothing over the dataset itself; a schema cannot declare a
field of that name.

A type that _does_ declare one – a `keyword`/`reference` field with
[`from: 'dataset'`](./search.md#projection-values) – makes that field the
collection’s provenance instead: the writer stamps it, the sweeps filter on it,
and no private `source` column is added beside it. One column then feeds the
facet, the query-time label resolution, any `derive` and the membership sweep,
so they cannot drift the way two copies of one IRI can.

Because the sweep deletes by it, a declared dataset field must be single-valued
and carry no `transform` (the sweep matches the stored value against the run’s
raw dataset IRIs), and – for `InPlaceRebuild`, which enumerates the indexed
datasets by faceting it – must be `facetable`. Each is checked when the writer
is constructed, so a declaration that cannot be swept fails before a run touches
the index. Declaring the dataset as an _internal_ field (no role at all, purely
so a `derive` can read it) is fine: the projection prunes it before the writer,
which falls back to `source`.

**Adopting the field needs a fresh collection.** `InPlaceRebuild` creates a
collection on demand and leaves an existing one alone, so a type that gains a
`from: 'dataset'` field against a collection built without it keeps the old
`source` column and has no field for the new one. Typesense stores the
unindexed value happily, so the run imports; `commit` then fails when the
membership sweep tries to facet a field the collection does not declare, and
the documents already stamped with `source` are no longer reachable by any
sweep. Drop and rebuild the collection when a type adopts the field.
(Blue/green builds a fresh collection every run, so it needs nothing.)

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
