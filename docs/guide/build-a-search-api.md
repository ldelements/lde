# Build a search API

In this tutorial you turn RDF datasets into a running GraphQL search API. The result is search as end users expect it – weighted fulltext matching with typo tolerance, faceted filtering, relevance ranking and pagination – none of which a SPARQL endpoint gives you.

You use the two prebuilt Docker images of the search family: the [indexer](../reference/search-indexer) writes datasets into a [Typesense](https://typesense.org/) index, and the [API server](../reference/search-api-server) serves that index over GraphQL. Both mount the same schema file, so the write and read side cannot disagree.

## Prerequisites

- Docker (with Compose).
- A DCAT dataset registry with a SPARQL endpoint, whose datasets themselves expose SPARQL endpoints. The examples use `https://registry.example.org/sparql` – replace it with yours.

## Step 1: Declare the search schema

The schema module declares, as plain data, what a search document looks like: one entry per root type, one field declaration per searchable or displayed property. Create `search-schema.mjs`:

```js
export default [
  {
    name: 'Dataset',
    class: 'http://www.w3.org/ns/dcat#Dataset',
    fields: [
      {
        name: 'title',
        path: 'http://purl.org/dc/terms/title',
        kind: 'text',
        locales: ['nl', 'en'],
        output: true,
        searchable: { weight: 5 },
      },
      {
        name: 'keyword',
        path: 'http://www.w3.org/ns/dcat#keyword',
        kind: 'keyword',
        array: true,
        facetable: true,
        output: true,
      },
    ],
  },
];
```

Each field’s `path` is the RDF predicate the indexer extracts its values from – the extraction query is generated from it, so a field without a `path` (and without a `derive` function) leaves nothing to extract, and the indexer refuses to boot. `searchable.weight` ranks title matches above matches in other fields; `facetable` makes keywords available for faceted filtering. The module must not import anything – it is validated at boot by whichever image mounts it. See [the schema module](../reference/search-api-server#the-schema-module) for the full format and TypeScript authoring.

## Step 2: Define the services

Create `compose.yaml` with the engine, the one-shot indexer, and the API server:

```yaml
services:
  typesense:
    image: typesense/typesense:30.2
    command: --data-dir /data --api-key=local-admin-key
    volumes:
      - typesense-data:/data

  indexer:
    image: ghcr.io/ldelements/search-indexer
    profiles: [index]
    volumes:
      - ./search-schema.mjs:/config/search-schema.mjs:ro
    environment:
      REGISTRY_ENDPOINT: https://registry.example.org/sparql
      TYPESENSE_HOST: typesense
      TYPESENSE_API_KEY: local-admin-key
    depends_on:
      - typesense

  search-api:
    image: ghcr.io/ldelements/search-api-server
    ports:
      - '4000:4000'
    volumes:
      - ./search-schema.mjs:/config/search-schema.mjs:ro
    environment:
      TYPESENSE_HOST: typesense
      TYPESENSE_API_KEY: local-admin-key
    depends_on:
      - typesense

volumes:
  typesense-data:
```

The `index` profile keeps the indexer out of `docker compose up`: it is a job you run, not a service that stays up. In production, give the API server a search-only Typesense key – it only ever reads.

## Step 3: Start the engine and the API

```sh
docker compose up --detach
```

## Step 4: Run the indexer

```sh
docker compose run --rm indexer
```

One run selects the registry’s datasets, extracts each root type per the schema, projects the results into search documents, rebuilds the Typesense collections, and exits. To index specific datasets only, set `DATASETS` to their IRIs. All options: [indexer configuration](../reference/search-indexer#configuration).

## Step 5: Query

Open the playground at `http://localhost:4000/graphql`, or query directly. Each root type gets a root field named after its lowercased name plus ‘s’ – here, `datasets` (set `queryField` in the schema options to override, e.g. for a name like `Category` that pluralizes differently):

```sh
curl -s http://localhost:4000/graphql \
  -H 'Content-Type: application/json' \
  -d '{"query": "{ datasets(query: \"map\") { pagination { total } items { id title { language value } } } }"}'
```

Try a typo – `"musem"` still finds your museums – and note the ranking: title matches come first, thanks to the field weights. `GET /graphql?sdl` returns the schema as SDL; `GET /health` reports liveness.

The `keyword` field was declared `facetable`, so the result also carries facets. Selecting a facet field is what requests it – each bucket is a value with the number of matching documents:

```sh
curl -s http://localhost:4000/graphql \
  -H 'Content-Type: application/json' \
  -d '{"query": "{ datasets(query: \"map\") { pagination { total } facets { keyword { value count } } } }"}'
```

Feed the buckets to filter checkboxes and pass the chosen values back as `where: { keyword: { in: ["maps"] } }`; a facet’s own filter is skipped when computing its buckets, so the other options stay visible.

## Where next

- Re-run the indexer on a schedule; a cross-pod lock makes overlapping runs fail fast. Choose between [in-place and blue/green rebuilds](../reference/search-typesense) with `REBUILD_MODE`.
- [Skip unchanged datasets](./skip-unchanged-datasets) across runs with `PROVENANCE_FILE` and `PIPELINE_VERSION`.
- Index datasets without live endpoints via the [QLever import path](../reference/search-indexer#the-qlever-import-path).
- Outgrown the turnkey images? Compose the pieces directly: [@lde/search](../reference/search), [@lde/search-pipeline](../reference/search-pipeline), [@lde/search-api-graphql](../reference/search-api-graphql).
