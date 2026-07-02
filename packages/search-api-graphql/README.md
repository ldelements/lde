# @lde/search-api-graphql

The GraphQL surface for the [`@lde/search`](../search) core. **Both engine- and
domain-agnostic:** it builds an executable `GraphQLSchema` from any `SearchType`
at runtime, and serves it with one generic resolver over any `SearchEngine`. It
names neither your **domain** (you pass `typeName` — `Dataset`, `Person`,
`CreativeWork`, …) nor your **engine** (the resolver calls `context.engine`, be it
[`@lde/search-typesense`](../search-typesense) or another adapter).

## Runtime configuration, not codegen

`buildGraphQLSchema(searchType, { typeName })` constructs the schema once at
startup from the field model — no SDL artifact, no generated resolver stubs. The
field model is the single source; the GraphQL contract is whatever it produces.
Output types, the `where`/`orderBy`/facet inputs, reference types and nullability
are all derived from each field’s `kind` and capability flags.

```ts
import { buildGraphQLSchema } from '@lde/search-api-graphql';

const gqlSchema = buildGraphQLSchema(DATASET, {
  typeName: 'Dataset',
  queryDefaults: (query) => ({
    ...query,
    where: [...query.where, { field: 'status', in: ['valid'] }],
  }),
});

// Hand `gqlSchema` to any graphql-js server; populate the per-request context:
//   { engine: SearchEngine, acceptLanguage: string[] }
```

## What it builds

- **Output type** (`typeName`) — localized text → best-first `[LanguageString!]!`
  (`[0].language` is the language actually served); references → named per-shape
  types (`Organization`, `Term`) with a `name`; scalars/booleans per kind; `date`
  → ISO 8601 string; nullability from `required` / `array` / `kind`.
- **`where`** — one input per `filterable` field (`StringFilter`, `IntRange` /
  `FloatRange` / `DateRange`, or `Boolean`).
- **`orderBy`** — `RELEVANCE` plus every `sortable` field, as an enum.
- **Facets** — an enum of every `facetable` field; a bucket carries `value` +
  `count` + a nullable `label` — the resolved data label for **reference** facets,
  `null` for token/free-string facets whose display the consumer owns (its own
  i18n, or the value itself).

## Why it can’t drift

The surface reads the same field model the index is built from, and compiles into
the same neutral `SearchQuery` the engine consumes — so the API, the index and a
future REST surface stay in lockstep. The contract is **frozen** (breaking to
change), and because it is generated rather than hand-written, a _consumer_ guards
it with a `printGraphQLSchema(searchType, options)` SDL snapshot over its **own**
search type and `typeName` — that snapshot also catches a `buildGraphQLSchema`
change in a future version of this library silently altering the consumer’s
contract.
