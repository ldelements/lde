# @lde/dataset-registry-client

A client for registries that contain [DCAT-AP 3.0](https://semiceu.github.io/DCAT-AP/releases/3.0.0/) dataset descriptions.

## Installation

```sh
npm install @lde/dataset-registry-client
```

## Usage

Create a `Client` for the registry’s SPARQL endpoint, then `query()` it with search criteria or with a custom SPARQL CONSTRUCT query. Both return a `Paginator` of [`@lde/dataset`](./dataset) `Dataset` objects that you can iterate asynchronously – but only criteria queries actually fetch page by page; a custom CONSTRUCT query or an `$id` lookup is fetched in a single call:

```ts
import { Client } from '@lde/dataset-registry-client';
import { rdfMediaTypes, sparqlMediaTypes } from '@lde/dataset';

const client = new Client(new URL('https://example.com/registry/sparql'));

const results = await client.query({
  distribution: {
    mediaType: {
      $in: [...sparqlMediaTypes, ...rdfMediaTypes],
    },
  },
});

console.log(results.total);
for await (const dataset of results) {
  console.log(dataset.iri.toString());
}
```

The `Client` constructor takes an optional second parameter: the [LDkit](https://ldkit.io) schema to query with, defaulting to the exported `DatasetSchema` (DCAT-AP 3.0 datasets).

## Search criteria

`SearchCriteria` follows `DatasetSchema`, so these fields are queryable:

- `title`, `description`, `language`, `license`
- `creator.name`, `publisher.name`
- `distribution.accessURL`, `distribution.mediaType`, `distribution.byteSize`, `distribution.compressFormat`, `distribution.conformsTo`, `distribution.modified`

A field matches either a plain value (equality) or an operator object:

- **`$id`** – top-level only: select a dataset by its IRI (or an array of IRIs). Fetched in a single call, without pagination.
- **`$in`** – match any of an array of values, e.g. `mediaType: { $in: [...sparqlMediaTypes, ...rdfMediaTypes] }`.
- **`$filter`** – a raw SPARQL expression for anything the other operators can’t express. Write `?value` for the property’s variable; it is substituted before the query runs:

```ts
const results = await client.query({
  distribution: {
    accessURL: { $filter: '!CONTAINS(STR(?value), "edm")' },
  },
});
```

Criteria are LDkit’s search interface, so LDkit’s other operators (`$equals`, `$not`, `$contains`, `$regex`, `$gt`, …) are available too – see the [LDkit documentation](https://ldkit.io).

## Custom queries

A custom query must be a SPARQL CONSTRUCT query – anything else throws `Must be CONSTRUCT query`. The client rewrites the query’s template before running it, adding `?firstSubject rdf:type ldkit:Resource` (where `?firstSubject` is the subject of the first template triple) so LDkit recognises the constructed resources as results. The whole result is fetched in one call.

## Paginator

`query()` resolves to a `Paginator<Dataset>`: an `AsyncIterable` with a `total` property. Criteria queries first run a `count()` to establish `total`, then fetch pages of 1 000 datasets as you iterate, so memory stays bounded regardless of registry size. Custom queries and `$id` lookups are pre-fetched in full, and the paginator simply replays them.

## Namespaces

The package also exports `dcat`, an LDkit namespace covering the full [DCAT 3 vocabulary](https://www.w3.org/TR/vocab-dcat-3/), for building custom schemas and queries.
