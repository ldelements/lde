# Select datasets from a registry

`ManualDatasetSelection` hard-codes the datasets a pipeline processes. This guide shows how to drive the pipeline from a [DCAT-AP 3.0](https://semiceu.github.io/DCAT-AP/releases/3.0.0/) dataset registry instead, so new datasets flow in without a code change.

## Point the pipeline at the registry

Create a `Client` for the registry’s SPARQL endpoint and pass it to `RegistrySelector` as the pipeline’s [dataset selector](../reference/pipeline#dataset-selector):

```typescript
import { Client } from '@lde/dataset-registry-client';
import { Pipeline, RegistrySelector } from '@lde/pipeline';

const pipeline = new Pipeline({
  datasetSelector: new RegistrySelector({
    registry: new Client(new URL('https://example.com/registry/sparql')),
  }),
  // …
});
```

Without further options the selector fetches every dataset in the registry. Results are paginated, so selection memory stays bounded regardless of registry size.

## Narrow the selection with criteria

Pass `criteria` to select only matching datasets – for example, only those with a SPARQL endpoint or an RDF data dump:

```typescript
import { rdfMediaTypes, sparqlMediaTypes } from '@lde/dataset';

const selector = new RegistrySelector({
  registry: new Client(new URL('https://example.com/registry/sparql')),
  criteria: {
    distribution: {
      mediaType: {
        $in: [...sparqlMediaTypes, ...rdfMediaTypes],
      },
    },
  },
});
```

Criteria follow the dataset schema, so any schema property can be matched. Two more operators cover the common cases `$in` doesn’t:

- **`$id`** selects a single dataset by IRI – useful when a pipeline run targets exactly one registry entry.
- **`$filter`** injects a raw SPARQL expression; write `?value` for the property being filtered.

Combined, they select one dataset while excluding some of its distributions:

```typescript
const selector = new RegistrySelector({
  registry: new Client(new URL('https://example.com/registry/sparql')),
  criteria: {
    $id: 'https://example.com/dataset/123',
    distribution: {
      accessURL: { $filter: '!CONTAINS(STR(?value), "edm")' },
    },
  },
});
```

See the [@lde/dataset-registry-client reference](../reference/dataset-registry-client) for the full query interface.

## Use a custom query for anything else

When criteria can’t express the selection, pass a SPARQL CONSTRUCT query instead – `query` takes precedence over `criteria`:

```typescript
const selector = new RegistrySelector({
  registry: new Client(new URL('https://example.com/registry/sparql')),
  query: constructQuery,
});
```

## Compose selectors

`DatasetSelector` is a one-method interface – `select(): Promise<Paginator<Dataset>>` – so composing selection strategies is just wrapping one selector in another plain object. For example, prefer a manual list but fall back to the registry when it selects nothing:

```typescript
import type { DatasetSelector } from '@lde/pipeline';

class FallbackSelector implements DatasetSelector {
  constructor(
    private readonly primary: DatasetSelector,
    private readonly fallback: DatasetSelector,
  ) {}

  async select() {
    const selected = await this.primary.select();
    return selected.total > 0 ? selected : this.fallback.select();
  }
}
```

The same shape covers other compositions, such as injecting per-dataset configuration onto the selected datasets before the pipeline sees them.

## In production

This is exactly how [@lde/search-indexer](../reference/search-indexer) selects its datasets: its `REGISTRY_ENDPOINT` and `DATASET_CRITERIA` environment variables feed a `RegistrySelector` at startup.
