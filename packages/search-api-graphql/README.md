# @lde/search-api-graphql

The GraphQL surface for the [`@lde/search`](../search) core. **Both engine- and
domain-agnostic:** it builds an executable
[graphql-js](https://graphql.org/graphql-js/) `GraphQLSchema` from your whole
[`SearchSchema`](../search/README.md#terminology) at runtime — one root query
field per `SearchType`, each searchable in its own way. All root fields are
served by the same resolver implementation (no per-type code, no codegen);
each root field gets its own instance of it, bound to that field’s
`SearchType`, over any `SearchEngine`. It names neither your **domain** (each type’s GraphQL name
is the `SearchType`’s own logical `name` — `Dataset`, `Person`, `CreativeWork`,
…) nor your **engine** (the resolver calls `context.engine`, be it
[`@lde/search-typesense`](../search-typesense) or another adapter).

## Runtime configuration, not codegen

`buildGraphQLSchema(schema)` constructs the GraphQL schema once at startup from
the field model — no SDL artifact, no generated resolver stubs. The field model
is the single source; the GraphQL contract is derived from it. Type names
come from each `SearchType`’s `name`; output types, the `where`/`orderBy`/facet
inputs, reference types and nullability are all derived from each field’s
`kind` and capability flags. The common case needs no options at all:

```ts
import { searchSchema } from '@lde/search';
import { buildGraphQLSchema } from '@lde/search-api-graphql';

const gqlSchema = buildGraphQLSchema(searchSchema(DATASET, PERSON));

// The API now serves `datasets(…)` and `persons(…)` root fields.
// Hand `gqlSchema` to any graphql-js server; populate the per-request context:
//   { engine: SearchEngine, acceptLanguage: string[] }
```

Per-type options are pure fine-tuning, only for the types that need it: a
`queryField` when the default root field (the lowercased plural of the type’s
`name`) is wrong, and a `queryDefaults` policy applied to every query of that
type:

```ts
const gqlSchema = buildGraphQLSchema(searchSchema(DATASET, PERSON), {
  types: {
    [DATASET.type]: {
      queryDefaults: (query) => ({
        ...query,
        where: [...query.where, { field: 'status', in: ['valid'] }],
      }),
    },
    [PERSON.type]: { queryField: 'people' },
  },
});
```

Shared types (`LanguageString`, the facet buckets, filter inputs and reference
types such as a common `Agent`) are created once and reused across root types.

## Serving a subset of the schema

`types` never filters: every `SearchType` in the schema you pass gets a root
field (options for a type not in the schema are a build-time error). To expose
only part of what you index, narrow the **schema argument**
(`searchSchema(…)` is a cheap constructor):

```ts
// Index all three types…
projectGraph(quads, searchSchema(DATASET, PERSON, INTERNAL));

// …but serve only two.
const gqlSchema = buildGraphQLSchema(searchSchema(DATASET, PERSON));
```

## What it builds (per root type)

- **Output type** (the `SearchType`’s `name`): localized text → best-first `[LanguageString!]!`
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

## Guarding the contract

Why the API, the index and a future REST surface cannot drift apart is the
search family’s overall approach — one field model, one query IR — described
in [`@lde/search`](../search/README.md). Specific to this surface: the GraphQL
contract is **frozen** (breaking to change), yet generated rather than
handwritten, so nothing in the repo shows a contract change as a reviewable
diff. A _consumer_ restores that with one snapshot test over its **own**
search schema:

```ts
import { printGraphQLSchema } from '@lde/search-api-graphql';

it('keeps the public GraphQL contract stable', () => {
  expect(printGraphQLSchema(searchSchema(DATASET, PERSON))).toMatchSnapshot();
});
```

The first run writes the emitted SDL to a committed snapshot file; every later
run re-emits and diffs against it. Any contract change — your own schema edit,
or a new version of this library emitting different GraphQL for the same
declaration — fails the test and shows the SDL diff, until you consciously
accept it (`vitest -u`) and the reviewer sees the contract change spelled out
in the PR.
