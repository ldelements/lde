# @lde/search-api-graphql

The GraphQL surface for the [`@lde/search`](../search) core. **Both engine- and
domain-agnostic:** it builds an executable `GraphQLSchema` from your whole
`SearchSchema` at runtime — one root query field per `SearchType`, each
searchable in its own way — served by one generic resolver per root field over
any `SearchEngine`. It names neither your **domain** (you pass a `typeName` per
type — `Dataset`, `Person`, `CreativeWork`, …) nor your **engine** (the resolver
calls `context.engine`, be it [`@lde/search-typesense`](../search-typesense) or
another adapter).

## Runtime configuration, not codegen

`buildGraphQLSchema(schema, { types })` constructs the GraphQL schema once at
startup from the field model — no SDL artifact, no generated resolver stubs. The
field model is the single source; the GraphQL contract is whatever it produces.
Output types, the `where`/`orderBy`/facet inputs, reference types and nullability
are all derived from each field’s `kind` and capability flags.

```ts
import { searchSchema } from '@lde/search';
import { buildGraphQLSchema } from '@lde/search-api-graphql';

const gqlSchema = buildGraphQLSchema(searchSchema(DATASET, PERSON), {
  types: {
    [DATASET.type]: {
      typeName: 'Dataset',
      queryDefaults: (query) => ({
        ...query,
        where: [...query.where, { field: 'status', in: ['valid'] }],
      }),
    },
    [PERSON.type]: { typeName: 'Person', queryField: 'people' },
  },
});

// The API now serves `datasets(…)` and `people(…)` root fields.
// Hand `gqlSchema` to any graphql-js server; populate the per-request context:
//   { engine: SearchEngine, acceptLanguage: string[] }
```

Per type you configure the `typeName` (drives all derived type names), an
optional `queryField` (defaults to the lowercased plural of `typeName`) and an
optional `queryDefaults` policy applied to every query of that type. Shared
types (`LanguageString`, the facet buckets, filter inputs and reference types
such as a common `Agent`) are created once and reused across root types.

## Serving a subset of the schema

`types` never filters: every `SearchType` in the schema you pass gets a root
field, and the options must cover them exactly — a type without options, or
options naming an unknown type, is a build-time error, so the API cannot
silently drift from the index. To expose only part of what you index, narrow
the **schema argument** instead (`searchSchema(…)` is a cheap constructor):

```ts
// Index all three types…
projectGraph(quads, searchSchema(DATASET, PERSON, INTERNAL));

// …but serve only two.
const gqlSchema = buildGraphQLSchema(searchSchema(DATASET, PERSON), {
  types: {
    [DATASET.type]: { typeName: 'Dataset' },
    [PERSON.type]: { typeName: 'Person', queryField: 'people' },
  },
});
```

Hiding a type is then a decision readable at the call site, never an
accidental omission from the options.

## What it builds (per root type)

- **Output type** (`typeName`): localized text → best-first `[LanguageString!]!`
  (`[0].language` is the language actually served); references → named per-shape
  types (`Organization`, `Term`) with a `name`; scalars/booleans per kind; `date`
  → ISO 8601 string; nullability from `required` / `array` / `kind`.
- **`where`** one input per `filterable` field (`StringFilter`, `IntRange` /
  `FloatRange` / `DateRange`, or `Boolean`); omitted entirely for a type with no
  filterable fields.
- **`orderBy`**: `RELEVANCE` plus every `sortable` field, as an enum.
- **Facets**: an enum of every `facetable` field; a bucket carries `value` +
  `count` + a nullable `label` — the resolved data label for **reference** facets,
  `null` for token/free-string facets whose display the consumer owns (its own
  i18n, or the value itself).

## Why it can’t drift

The surface reads the same field model the index is built from, and compiles into
the same neutral `SearchQuery` the engine consumes — so the API, the index and a
future REST surface stay in lockstep. The contract is **frozen** (breaking to
change), and because it is generated rather than handwritten, a _consumer_ guards
it with a `printGraphQLSchema(schema, options)` SDL snapshot over its **own**
search schema and type names — that snapshot also catches a `buildGraphQLSchema`
change in a future version of this library silently altering the consumer’s
contract.
