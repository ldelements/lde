# @lde/resolver

Everything around fetching a fact from outside the graph: a durable store,
bounded outbound work, retry with backoff, failure isolation and a cap on how
much a single run may fetch. You write the fetch and what to do with the answer.

## Installation

```sh
npm install @lde/resolver
```

```ts
import { createResolver, sqliteFactStore } from '@lde/resolver';

// One store per process; one resolver per run.
const store = sqliteFactStore({ path: '/data/places.sqlite' });

const resolver = createResolver({
  key: (iri: string) => iri,
  host: 'termennetwerk-api.netwerkdigitaalerfgoed.nl',
  fetch: async (iris, { signal }) =>
    (await lookup(iris, { signal })).map((term) => [
      term.uri,
      coordinatesOf(term),
    ]),
  store,
  limits: { batchSize: 25, fetchesPerResolver: 5_000 },
});

const resolved = await resolver.resolveAll(placeIris);
```

## Documentation

See the [full documentation](https://ldelements.org/reference/resolver).
