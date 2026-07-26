# @lde/search-api-graphql

The GraphQL surface for the [`@lde/search`](../search) core. **Both engine- and
domain-agnostic:** it builds an executable
[graphql-js](https://graphql.org/graphql-js/) `GraphQLSchema` from your whole
[`SearchSchema`](../search/README.md#terminology) at runtime – one root query
field per `SearchType`, each searchable in its own way.

## Installation

```sh
npm install @lde/search-api-graphql
```

```ts
import { searchSchema } from '@lde/search';
import { buildGraphQLSchema } from '@lde/search-api-graphql';

const gqlSchema = buildGraphQLSchema(searchSchema(DATASET, PERSON));

// The API now serves `datasets(…)` and `persons(…)` root fields.
// Hand `gqlSchema` to any graphql-js server; populate the per-request context:
//   { engine: SearchEngine, acceptLanguage: string[] }
```

## Documentation

See the [full documentation](https://ldelements.org/reference/search-api-graphql).
