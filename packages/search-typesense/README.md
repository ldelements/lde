# @lde/search-typesense

Generic [Typesense](https://typesense.org/) engine adapter for RDF-backed search
pipelines: frame quads into documents, build collections, bulk upsert, and swap
a blue/green alias.

The package is engine-specific (Typesense) but domain-agnostic: it knows nothing
about any particular vocabulary. Callers supply the RDF root type and map the
framed intermediate representation to their own document fields.

## Framing quads → IR

`frameByType()` turns the result of a SPARQL `CONSTRUCT` into one JSON-LD node
per subject of `rootType` — the engine-agnostic intermediate representation a
projector then maps to a flat search document.

```ts
import { frameByType } from '@lde/search-typesense';

for await (const node of frameByType(
  quads,
  'http://www.w3.org/ns/dcat#Dataset',
)) {
  // node is a framed JSON-LD object with full-IRI keys, e.g.
  // node['http://purl.org/dc/terms/title'] === [{ '@value': 'Titel', '@language': 'nl' }]
  documents.push(toDocument(node));
}
```

Each root subject's one-hop subgraph (e.g. a nested publisher or distribution
resource) is framed **independently** and yielded one at a time, so memory stays
flat at scale — framing the whole graph at once is roughly O(N²). Duplicate
triples are collapsed first, because some SPARQL engines (e.g. QLever) do not
deduplicate `CONSTRUCT` output. The frame carries no `@context`, so framed keys
are full predicate IRIs and language tags are preserved.

A lower-level flat `frame(quads, subject, fields)` is also exported: a direct
predicate-to-field mapping with datatype coercion, for documents that need no
nesting and no language tags.

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

It also provides `ensureCollection`, `partialUpdate`, `aliasTarget`,
`documentIds(collection, filterBy?)` and `deleteByIds()` for incremental and
scoped maintenance.
