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
// only one batch is held in memory at a time. `rebuild` returns the count.
const imported = await rebuild(client, 'datasets', schema, documents);
```

The versioned collection name comes from `schema.name`, so the caller controls
naming (e.g. `datasets_<timestamp>`). On any failure before the swap nothing is
repointed – the live alias never points at a partial build – and the orphaned
half-built collection is dropped.
