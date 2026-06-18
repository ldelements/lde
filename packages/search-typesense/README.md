# @lde/search-typesense

[Typesense](https://typesense.org/) engine adapter for RDF-backed search
pipelines. Engine-specific (Typesense) but domain-agnostic – the caller supplies
the collection schema and documents.

The engine-agnostic half of the pipeline – framing `CONSTRUCT` quads into a
JSON-LD IR and projecting that IR into flat documents from a declarative field
spec – lives in [`@lde/search`](../search). This package consumes those
documents and writes them to Typesense.

## Indexing

`rebuild` blue/green-publishes a freshly built collection behind an alias in one
call: it creates the versioned collection, streams the documents into it in
batches, atomically repoints the alias, then drops the collection it superseded.

```ts
import { createTypesenseClient, rebuild } from '@lde/search-typesense';

const client = createTypesenseClient(connection);

// `documents` is an array or an async iterable (e.g. a streaming projection);
// only one batch is held in memory at a time.
const imported = await rebuild(client, 'datasets', schema, documents);
```

The versioned collection name comes from `schema.name`, so the caller controls
naming (e.g. `datasets_<timestamp>`). On any failure before the swap nothing is
repointed – the live alias never points at a partial build – and the orphaned
half-built collection is dropped.

## Concurrency

`rebuild` is **single-flight per alias**: it first takes a lock (a marker
document in a `rebuild_locks` collection, created on demand) via Typesense’s
atomic create, so concurrent callers across pods never rebuild the same alias at
once. A call made while another rebuild for that alias is in flight returns
`null` instead of a count. This makes blue/green safe under replication: without
it, two same-millisecond rebuilds would create the same `schema.name` and one
would delete the other’s in-flight collection.

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
