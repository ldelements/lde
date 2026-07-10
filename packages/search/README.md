# @lde/search

The core of the LDE search family: packages that together act as a **generator
for search engines**. You write one declarative `SearchSchema`, and everything
a running search engine needs is derived from it: the document projection, the
engine collection schema, the query semantics, and the API surface. All these
are kept in sync automatically rather than handwritten per deployment.

The core itself is **engine-, API- and domain-agnostic**: it bakes in no search
engine, no API protocol, and no domain vocabulary. The engine- and API-specific
halves are adapters that plug into the ports defined here:

- **engine adapters** implement the `SearchEngine` port:
  [`@lde/search-typesense`](../search-typesense), with OpenSearch to follow;
- **API surfaces** drive it, parsing client input into `search(SearchQuery)`:
  [`@lde/search-api-graphql`](../search-api-graphql), with a REST
  surface to follow.

The library never names your domain: the same core drives a `Dataset`,
`Person`, or `CreativeWork` search.

It provides four things:

- **unified field model** — `SearchField` / `SearchType` / `SearchSchema`:
  one declaration per field that drives all four consumers below, so they
  cannot drift;
- **neutral query IR** — `SearchQuery` / `Filter` / `Sort` + filter
  semantics: every API surface compiles into it, every engine adapter compiles
  out of it, so the two cannot drift;
- **engine port** — `SearchEngine` and the logical result types
  (`SearchResult` / `SearchHit` / `ResultDocument` / `Reference` / …);
- **streaming projection** — `projectGraph`, RDF `CONSTRUCT` quads → flat
  search documents.

```
SearchSchema ─┬─► projection      (projectGraph → flat documents)        [here]
              ├─► engine adapter  (collection schema + query compiler)   e.g. @lde/search-typesense
              ├─► query semantics (SearchQuery, filter/sort/facet)       [here]
              └─► API surface     (GraphQL / REST)                       e.g. @lde/search-api-graphql
```

At runtime, everything those consumers do is a **pure transformation between
data shapes**, each one parameterised by the schema — three chains, meeting at
the engine:

```
indexing:  RDF quads ──frame──► FramedNode ──project──► SearchDocument ──import──► engine
querying:  client input ──parse──► SearchQuery ──compile──► engine query
results:   engine response ──parse──► SearchResult ──shape──► API output
```

Validation happens before the first arrow (SHACL over the RDF) and inside the
last (the engine enforces its collection schema); between them every stage is
a typed, deterministic function — easy to test, and swappable per deployment.

## Entry points

Exports are stratified by audience:

- **`@lde/search`** — the authoring surface: `defineSearchType`,
  `searchSchema`, `projectGraph` (+ the IR readers `derive` functions use),
  validation, and every model/query/result type.
- **`@lde/search/adapter`** — plumbing for engine adapters and API surfaces:
  `physicalFields`, the field selectors, `assertValidQuery`, the filter
  operators and storage codecs.
- **`@lde/search/testing`** — `describeSearchEngineContract`, the executable
  port contract every engine adapter runs against a live instance of itself
  (vitest; optional peer).

## Terminology

The model has three levels, with analogues in SHACL ([one possible source](#why-a-declarative-model))
and GraphQL (one of the surfaces):

| Term           | What it is                                                                                                      | SHACL          | GraphQL     |
| -------------- | --------------------------------------------------------------------------------------------------------------- | -------------- | ----------- |
| `SearchField`  | One queryable field: a `kind`, the IR `path` it projects from, and the capability flags it opts into            | property shape | field       |
| `SearchType`   | One root type’s complete declaration: its logical API `name`, its `type` IRI and its fields (incl. derived)     | NodeShape      | object type |
| `SearchSchema` | The whole search declaration: every `SearchType`, keyed by `type` IRI — build one with `searchSchema(...types)` | shapes graph   | schema      |

`projectGraph` and the GraphQL surface consume a `SearchSchema` (projecting
every type in one pass); the engine port executes one `SearchType` at a time.

### API conventions

Two conventions hold across the whole family:

- **Parameter order** — a function takes the value it operates on first and
  the declaration right after it: `projectDocument(node, type)`,
  `buildSearchParams(query, type)`,
  `createTypesenseSearchEngine(client, schema, options)`,
  `engine.search(type, query)`.
- **Factory verbs** — the verb tells you what kind of thing comes back.
  `define*` captures a declaration as a literal (`defineSearchType`);
  `build*` is a pure data-to-data constructor (`buildCollectionSchema`,
  `buildSearchParams`, `buildGraphQLSchema`); `create*` makes a stateful
  instance (`createTypesenseSearchEngine`). A bare noun (`searchSchema`)
  constructs the trivial container it names.

## Field model

The mapping is data, not code. Each field declares its `kind`, the IR `path` to
read (or a `derive` function for a **derived** field, computed from the framed
node in declaration order — so it may read fields declared before it), and the
capabilities it opts into. The physical field names a declaration fans out to
(per-locale search/sort keys) come from
`physicalFields`, the single convention projection, the collection schema and the
query compiler all share.

```ts
import {
  defineSearchType,
  projectGraph,
  irisOf,
  searchSchema,
} from '@lde/search';

const DATASET = defineSearchType({
  name: 'Dataset', // logical API name: names the GraphQL type, a REST path, …
  type: 'http://www.w3.org/ns/dcat#Dataset',
  fields: [
    // → title_nl, title_en, title_search_nl/_en, title_sort_nl/_en
    {
      name: 'title',
      path: 'http://purl.org/dc/terms/title',
      kind: 'text',
      locales: ['nl', 'en'],
      output: true,
      searchable: { weight: 5 },
      sortable: true,
    },
    // → publisher (IRI facet, resolved to a labelled reference at the surface)
    {
      name: 'publisher',
      path: 'http://purl.org/dc/terms/publisher',
      kind: 'reference',
      facetable: true,
      output: true,
      ref: { typeName: 'Organization', strategy: 'labelOnly' },
    },
    // → size (int)
    { name: 'size', path: 'urn:dr:size', kind: 'integer', sortable: true },
    // derived field (no path): computed from the framed node
    {
      name: 'classCount',
      kind: 'integer',
      sortable: true,
      derive: (node) => irisOf(node, 'urn:dr:class').length,
    },
  ],
});

for await (const { searchType, document } of projectGraph(
  quads,
  searchSchema(DATASET),
)) {
  // one flat search document per matching subject, streamed and tagged with the
  // SearchType it was framed from — so a multi-collection writer can route each
  // document to the collection for its type. A single-collection consumer just
  // reads `document`.
}
```

`defineSearchType` captures the declaration as a literal (what
`as const satisfies SearchType` would do manually, with nothing to remember),
so typed facet/output keys can be derived from it — see
[Typed results](#typed-results) and `@lde/search-api-graphql`.

**Kinds** (`FieldKind`): `text`, `keyword`, `integer`, `number`, `boolean`,
`date`, `reference`. The Typesense/engine vocabulary and the GraphQL types are
_derived_ from the kind by the adapter and the surface — never declared here.

`SearchField` is a **discriminated union by `kind`** (`TextField`,
`KeywordField`, `ReferenceField`, `NumericField`, `BooleanField`): each kind
declares exactly the properties it can honour — `locales` on text, `ref` on
references, `facetRanges` on numerics — so an illegal declaration fails to
compile. Text is **always multilingual in shape**: `locales` lists the
language tags to fan out, and the reserved **`und`** locale (JSON-LD `@none`,
RDF `und`) buckets untagged literals — a monolingual or untagged corpus
declares `locales: ['und']`, mixed data `['nl', 'und']`. Declaring a real
language is recommended (it drives per-locale stemming); `und` is folded but
unstemmed unless `defaultLocale` opts in, is never demoted in search
weighting, and adding a language later is additive — the API output shape
never changes. Use `keyword` for exact-match tokens, never for prose.

**Declarations are also validated at runtime** (for declarations built
outside TypeScript — a SHACL generator, plain JS): `searchSchema()`
rejects a structurally invalid declaration (duplicate field names, an `output`
reference without `ref`, `text` without locales, `locales` on a non-text kind,
`facetRanges` on a non-numeric kind, `searchable`/`transform` on a kind whose
projection cannot honour it, `filterable`/`facetable` on `text`, two types
sharing a `type` IRI or `name`) — the declaration-time counterpart of the
port’s always-on query validation, so a bad schema fails at startup rather
than per document at index time. `validateSearchType` /
`assertValidSearchType` are exported for validating a single declaration
directly.

| kind                 | `where`              | facet | sort             | output                          |
| -------------------- | -------------------- | ----- | ---------------- | ------------------------------- |
| `text`               | – (feeds free text)  | –     | yes (per-locale) | best-first language list        |
| `keyword`            | `in` (membership)    | yes   | –                | string / `string[]`             |
| `reference`          | `in` (membership)    | yes   | –                | labelled reference (id + label) |
| `integer` / `number` | `range { min, max }` | yes   | yes              | number                          |
| `date`               | `range` (inclusive)  | yes   | yes              | ISO 8601 string (surface)       |
| `boolean`            | `is`                 | yes   | –                | boolean (absent = false)        |

A `reference` carries `labelOnly` today (id + display label); the `idOnly` and
`inline` strategies are forward declarations. References are object-shaped from
day one so that `inline` can later **add** fields to a reference type without
breaking clients.

A reference resolves its label from a **label source**: `labelSource` names
the `SearchType` whose collection holds the referenced entities. The named
type must declare an `output`, `searchable` text field called `label` –
`searchSchema` validates this schema-wide, so a dangling or unsuitable label
source fails at startup. A reference without a `labelSource` stays id-only.

## Projection

`projectGraph` is fully streaming: subjects are grouped and framed one at a time
and documents are yielded as produced, so beyond a subject index memory stays
flat at scale (framing the whole graph at once is roughly O(N²)). Duplicate
triples are collapsed first, because some SPARQL engines (e.g. QLever) do not
deduplicate `CONSTRUCT` output. The IR carries no `@context`, so a `derive` function
reading it sees full predicate IRIs with language tags preserved.

Each yielded value is a `{ searchType, document }` pair: the whole schema
projects into **one** mixed stream, and every document is tagged with the
`SearchType` it was framed from. That tag is what lets the write side fan the
stream out to per-type collections without re-deriving the type from the
document — see `@lde/search-pipeline`’s multi-collection writer.

`projectGraph` **consumes the quads once** – a single scan builds the subject
index every type frames off – and so accepts any `Iterable<Quad>`, not just a
materialized array. A caller merging several sources can pass a chained
generator instead of building a third full array at the projection peak:

```ts
projectGraph(
  (function* () {
    yield* registerQuads;
    yield* dkgQuads;
  })(),
  schema,
);
```

## Locales

`locales` is the **single** list of locales a `text` field projects (`und` =
untagged literals);
`output`, `searchable` and `sortable` are independent opt-ins that each fan out
over it (so a field emits exactly what it opts into):

- `output` → `title_nl`/`title_en` (accents preserved);
- `searchable` → `title_search_nl`/`title_search_en` (folded; one field per locale
  lets a query `query_by` them and rank the user’s language higher, and lets a
  language that needs a dedicated tokenizer set its own stemming `locale` in the
  engine schema);
- `sortable` → `title_sort_nl`/`title_sort_en` (folded, so a locale-switching UI
  sorts on the active language).

A field with `searchable` but no `output` is **search-only** — folded and stemmed
for retrieval but never rendered (e.g. a creator searched here but shown via a
separate label). **Only listed locales are indexed**; a literal whose language tag is not in
`locales` is not projected (declare `und` to catch untagged literals). Per-locale fields are
**omitted, never empty**, when a document lacks that language, so declare them
optional in the engine schema and sort with `missing_values: last`.

Folding the search fields is what lets diacritic-insensitive matching and
stemming coexist. A search engine on its **default** locale typically folds case
and diacritics for you; enabling a language’s **stemming** switches it to ICU
tokenization, which **preserves** diacritics — at which point `fold()` (from
[`@lde/text-normalization`](../text-normalization)) is what keeps matching
diacritic-insensitive. Stemming is rules-based and can mangle proper nouns (the
Dutch stemmer reduces the city `Bergen` to `berg`), so enable it on free-text
fields and keep proper-noun facets on a separate, unstemmed field.

## Querying

The search fields are stored already case- and diacritic-folded, so **the query
must be folded the same way** with the same `fold()` before it reaches the engine,
or index and query normalize differently and matches silently miss. This contract
holds for **any** consumer, including an API built on this package — which is why
engine adapters and surfaces compile through the shared `SearchQuery` IR and the
`physicalFields` convention rather than re-deriving field names.

Queries are **always validated**: the port contract requires every engine
adapter to reject a structurally invalid `SearchQuery` (`assertValidQuery`) —
unknown or non-`filterable` fields in `where`, an operator not matching the
field’s kind, non-`facetable` facet requests — no matter which surface or
policy produced it. A typed surface like GraphQL makes most of these
unrepresentable; the port enforces them for everyone else (deployment
`queryDefaults`, in-process callers, weaker-typed surfaces).

## Typed results

An engine is **bound to the whole `SearchSchema` at construction** — like
every other schema consumer (`projectGraph(quads, schema)`,
`buildGraphQLSchema(schema)`): the adapter factory takes the deployment’s
declaration together with each type’s physical location, so a query can never
meet the wrong index, and deployment-level concerns (the label cache,
cross-type search, facet batching) have one home. A search names its type per
call. Because `searchSchema()` captures the declared types as a literal
tuple, `search()` accepts **only the deployment’s own types** (a foreign type
is a compile error) and returns facet/document keys typed by the type passed
— no caller-side generics:

```ts
const engine = createTypesenseSearchEngine(client, schema, {
  collections: { Dataset: 'datasets', Person: 'people' }, // omitting one = type error
});

const result = await engine.search(DATASET, query);
result.facets.publisher; // typed: only DATASET’s facetable fields are keys
result.facets.publsher; // compile error (typo)
result.hits[0].document.title; // typed: only DATASET’s output fields are keys
await engine.search(OTHER_TYPE, query); // compile error: not in this schema
```

`searchFacets(type, queries)` is the port’s **batch entry point**: several
facet-only queries – e.g. a faceted listing’s skip-own-filter variants –
answered in one engine round-trip (Typesense: a single `multi_search`), one
outcome per query, positionally aligned – its facet map, or an in-place error,
so one failed query never discards its siblings’ facets. The same schema
binding, per-query validation and typed facet keys apply to every query in
the batch.

This only works when the types were declared with `defineSearchType` (or
captured `as const satisfies SearchType`) and composed with `searchSchema()`;
a plain `: SearchSchema` annotation widens gracefully to string keys.
`FacetFieldsOf`/`OutputFieldsOf` are exported for annotating your own
signatures, and `engine.schema` exposes the bound declaration for routing.

## Why a declarative model

The vocabulary mirrors SHACL on purpose: `path` is `sh:path`, `array` is
`sh:maxCount`, `required` is `sh:minCount`, `locales` is `sh:languageIn`, `ref`
is `sh:class`/`sh:node`. So the same core that runs a hand-written `SearchSchema`
today will run a **SHACL-generated** one tomorrow — the model, the ports and the
IR stay; only schema-authoring gets automated.
