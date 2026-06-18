# @lde/search-typesense

[Typesense](https://typesense.org/) engine adapter for RDF-backed search
pipelines. Engine-specific (Typesense) but domain-agnostic – the caller supplies
the collection schema and documents.

The engine-agnostic half of the pipeline – framing `CONSTRUCT` quads into a
JSON-LD IR and projecting that IR into flat documents from a declarative field
spec – lives in [`@lde/search`](../search). This package consumes those
documents and writes them to Typesense.

## Indexing

`rebuild` blue/green-rebuilds a search index in one call: it creates a fresh
versioned collection (`${schema.name}_<timestamp>`), streams the documents into
it in batches, atomically repoints the `schema.name` alias to it, then drops the
collection it superseded. The caller passes only the logical index name (as
`schema.name`) and a stream of documents; the versioned collection and the alias
are managed for them.

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
const result = await rebuild(client, schema, documents);
```

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
