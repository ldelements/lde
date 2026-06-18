# @lde/search-typesense

[Typesense](https://typesense.org/) engine adapter for RDF-backed search
pipelines: build collections, bulk upsert documents, and swap a blue/green
alias. Engine-specific (Typesense) but domain-agnostic — callers supply the
collection schema and documents.

The engine-agnostic half of the pipeline — framing `CONSTRUCT` quads into a
JSON-LD IR (`frameByType`) and projecting that IR into flat documents from a
declarative field spec (`projectDocument`) — lives in
[`@lde/search`](../search). This package consumes those documents and writes
them to Typesense.

## Indexing

`TypesenseAdapter` wraps the Typesense client with the operations a full-rebuild
indexer needs:

```ts
import { createTypesenseClient, TypesenseAdapter } from '@lde/search-typesense';

const adapter = new TypesenseAdapter(createTypesenseClient(connection));

await adapter.createCollection(schema); // versioned collection
await adapter.bulkUpsert(collection, documents);
await adapter.swapAlias(alias, collection); // atomic blue/green swap
await adapter.deleteCollection(previous);
```

`aliasTarget(alias)` reads the alias’s current target (the previous collection)
so a rebuild can drop it after the swap.
