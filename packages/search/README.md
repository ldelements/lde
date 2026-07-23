# @lde/search

The core of the LDE search family: packages that together act as a **generator
for search engines**. You write one declarative `SearchSchema`, and everything
a running search engine needs is derived from it: the document projection, the
engine collection definition, the query semantics, and the API surface. All these
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

- **unified field model** – `SearchField` / `SearchType` / `SearchSchema`:
  one declaration per field that drives all four consumers below, so they
  cannot drift;
- **neutral query IR** – `SearchQuery` / `Filter` / `Sort` + filter
  semantics: every API surface compiles into it, every engine adapter compiles
  out of it, so the two cannot drift;
- **engine port** – `SearchEngine` and the logical result types
  (`SearchResult` / `SearchHit` / `ResultDocument` / `Reference` / …);
- **streaming projection** – `projectRoots`, RDF `CONSTRUCT` quads → flat
  search documents, one root type at a time.

```
SearchSchema ─┬─► projection      (projectRoots → flat documents)        [here]
              ├─► engine adapter  (collection definition + query compiler)   e.g. @lde/search-typesense
              ├─► query semantics (SearchQuery, filter/sort/facet)       [here]
              └─► API surface     (GraphQL / REST)                       e.g. @lde/search-api-graphql
```

At runtime, everything those consumers do is a **pure transformation between
data shapes**, each one parameterised by the schema – three chains, meeting at
the engine:

```
indexing:  RDF quads ──frame──► FramedNode ──project──► SearchDocument ──import──► engine
querying:  client input ──parse──► SearchQuery ──compile──► engine query
results:   engine response ──parse──► SearchResult ──shape──► API output
```

Validation happens before the first arrow (SHACL over the RDF) and inside the
last (the engine enforces its collection definition); between them every stage is
a typed, deterministic function – easy to test, and swappable per deployment.

## Entry points

Exports are stratified by audience:

- **`@lde/search`** – the authoring surface: `defineSearchType`,
  `searchSchema`, `projectRoots`, validation, and every model/query/result type.
- **`@lde/search/adapter`** – plumbing for engine adapters and API surfaces:
  `physicalFields`, the field selectors, `assertValidQuery`, the filter
  operators and storage codecs.
- **`@lde/search/testing`** – `describeSearchEngineContract`, the executable
  port contract every engine adapter runs against a live instance of itself
  (vitest; optional peer).

## Terminology

The model has three levels, with analogues in SHACL ([one possible source](#why-a-declarative-model))
and GraphQL (one of the surfaces):

| Term           | What it is                                                                                                                                                                                                                       | SHACL          | GraphQL     |
| -------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------- | ----------- |
| `SearchField`  | One queryable field: a `kind`, the IR `path` it projects from, and the capability flags it opts into                                                                                                                             | property shape | field       |
| `SearchType`   | One type’s complete declaration: its logical API `name` and fields (incl. derived). A **Root Type** declares a `class` (indexed, keys the schema); a **Reference Type** declares none (reached only through an inline reference) | NodeShape      | object type |
| `SearchSchema` | The whole search declaration: every Root Type, keyed by `class` IRI, plus the Reference Types – build one with `searchSchema(...types)`                                                                                          | shapes graph   | schema      |

A `SearchType` is a **Root Type** or a **Reference Type**, told apart by one
absence: a Root Type declares a `class`, so roots are selected for it and a
writer opens a collection for it; a Reference Type declares none, so it is
never selected, framed by type or indexed – its identity is its name, and its
type comes from the edge that points at it. `searchSchema` partitions its
arguments accordingly: Root Types key the class map (`schema.values()` yields
only them, so no writer ever opens a collection for a Reference Type), Reference
Types go into a name index an inline `ref.typeName` resolves against. The
absence is load-bearing, and enforced at the type level – an indexed Reference
Type fails to compile ([ADR 11](../../docs/decisions/0011-decouple-rdf-depth-from-the-api-surface.md)).

`projectRoots` and the engine port each execute one `SearchType` at a time –
projection over the roots the pipeline selector supplied for that type; the
GraphQL surface consumes the whole `SearchSchema`.

### API conventions

Two conventions hold across the whole family:

- **Parameter order** – a function takes the value it operates on first and
  the declaration right after it: `projectDocument(node, type)`,
  `buildSearchParams(query, type)`,
  `createTypesenseSearchEngine(client, schema, options)`,
  `engine.search(type, query)`.
- **Factory verbs** – the verb tells you what kind of thing comes back.
  `define*` captures a declaration as a literal (`defineSearchType`);
  `build*` is a pure data-to-data constructor (`buildCollectionDefinition`,
  `buildSearchParams`, `buildGraphQLSchema`); `create*` makes a stateful
  instance (`createTypesenseSearchEngine`). A bare noun (`searchSchema`)
  constructs the trivial container it names.

## Field model

The mapping is data, not code. Each field declares its `kind`, the IR `path` to
read (or a `derive` function for a **derived** field, computed from the document
in declaration order – so it may read fields declared before it, never the
graph), and the capabilities (**roles**) it opts into. `path` is therefore the
complete statement of what the projection reads from the graph. A field that
declares **no** role is an **internal field**: projected so a later `derive` can
read it, then pruned before the writer and absent from the collection definition
– not stored, not indexed, no RAM. The physical field names a declaration fans
out to (per-locale search/sort keys) come from `physicalFields`, the single
convention projection, the collection definition and the query compiler all
share.

```ts
import { defineSearchType, projectRoots, searchSchema } from '@lde/search';

const DATASET = defineSearchType({
  name: 'Dataset', // logical API name: names the GraphQL type, a REST path, …
  class: 'http://www.w3.org/ns/dcat#Dataset',
  fields: [
    // → title_<lang> (display, every present language), title_search_nl/_en, title_sort_nl/_en
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
    // internal field (no role): projected as a reading device for the derive
    // below, then pruned before the writer – absent from the collection too
    { name: 'classes', path: 'urn:dr:class', kind: 'reference' },
    // derived field (no path): computed from the document in declaration order,
    // never from the graph – so `path` stays the whole statement of what is read
    {
      name: 'classCount',
      kind: 'integer',
      sortable: true,
      derive: (document) =>
        (document.classes as string[] | undefined)?.length ?? 0,
    },
  ],
});

const schema = searchSchema(DATASET);
for await (const document of projectRoots(quads, roots, schema, DATASET)) {
  // one flat search document per given root subject, streamed. The caller (the
  // pipeline selector) supplies `roots`; pairing a document with its type for a
  // multi-collection writer is the pipeline glue’s job (see
  // `@lde/search-pipeline`), not the projection’s.
}
```

`defineSearchType` captures the declaration as a literal (what
`as const satisfies SearchType` would do manually, with nothing to remember),
so typed facet/output keys can be derived from it – see
[Typed results](#typed-results) and `@lde/search-api-graphql`.

**Kinds** (`FieldKind`): `text`, `keyword`, `integer`, `number`, `boolean`,
`date`, `reference`. The Typesense/engine vocabulary and the GraphQL types are
_derived_ from the kind by the adapter and the surface – never declared here.

`SearchField` is a **discriminated union by `kind`** (`TextField`,
`KeywordField`, `ReferenceField`, `NumericField`, `BooleanField`): each kind
declares exactly the properties it can honour – `locales` on text, `ref` on
references, `facetRanges` on numerics – so an illegal declaration fails to
compile. Text is **always multilingual in shape**: `locales` lists the
language tags to **index** (search/sort), and the reserved **`und`** locale
(JSON-LD `@none`, RDF `und`) buckets untagged literals – a monolingual or
untagged corpus declares `locales: ['und']`, mixed data `['nl', 'und']`.
Display, by contrast, keeps every language present, not only the listed ones
(see [Locales](#locales)). Declaring a real language is recommended (it drives
per-locale stemming); `und` is folded but unstemmed unless `defaultLocale` opts
in, is never demoted in search weighting, and adding a language later is
additive – the API output shape never changes. Use `keyword` for exact-match
tokens, never for prose.

**Declarations are also validated at runtime** (for declarations built
outside TypeScript – a SHACL generator, plain JS): `searchSchema()`
rejects a structurally invalid declaration (duplicate field names, an `output`
reference without `ref`, `text` without locales, `locales` on a non-text kind,
`facetRanges` on a non-numeric kind, `searchable`/`transform` on a kind whose
projection cannot honour it, `filterable`/`facetable` on `text`, two types
sharing a `class` IRI or `name`) – the declaration-time counterpart of the
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

A `reference` carries one of two strategies today: `labelOnly` (id + display
label, resolved at query time from a label source) and `inline` (the referent’s
own projected fields, carried inline). `idOnly` stays a forward declaration.

An **inline reference** resolves `ref.typeName` to a declared **Reference Type**
and projects the referent through it – a nested `SearchDocument`, or an array
for an `array` reference. Roles decide whether the nesting surfaces, so the same
construct serves two jobs (see
[ADR 11](../../docs/decisions/0011-decouple-rdf-depth-from-the-api-surface.md)):

- a **reading device** declares no role, so it is an internal field: projected
  so a later `derive` can select and flatten a value a `path` cannot address (a
  qualified hop), then pruned before the writer – nothing nested reaches the
  engine or the API;
- an **API device** declares `output`, deliberately surfacing the nested
  Reference Type.

So RDF depth and API shape stay independent: inline as deep as the source
demands, expose exactly the flat fields you want. Framing follows the inline
reference graph to the depth the schema declares (`Dataset → Subset →
Measurement` is two hops), and `searchSchema` rejects inline cycles – the one
way that depth could be unbounded – so it stays a bounded property of the
declaration.

A reference resolves its label from a **label source**: `labelSource` names
the `SearchType` whose collection holds the referenced entities. The named
type must declare an `output`, `searchable` text field called `label` –
`searchSchema` validates this schema-wide, so a dangling or unsuitable label
source fails at startup. A reference without a `labelSource` stays id-only.

## Projection

`projectRoots` projects **one root type** over the roots the caller supplies –
the pipeline selector already holds them, so nothing is discovered from
`rdf:type` and a `CONSTRUCT` need emit no type triple. It is fully streaming:
each root’s subgraph is framed one at a time and its document yielded as
produced, so beyond a subject index memory stays flat at scale (framing the
whole graph at once is roughly O(N²)). Duplicate triples are collapsed first,
because some SPARQL engines (e.g. QLever) do not deduplicate `CONSTRUCT` output.
Every predicate a value comes from is read through a field’s `path`; a `derive`
computes only from the document projected so far, so `path` is the whole
statement of what the projection reads. `assertTypeInSchema` guards that
the passed `SearchType` is a member of the schema – the port’s own membership
check – so no schema is ever forged to scope a projection to one type.

**Blank-node roots are not indexable**: a blank node has no stable document
key, so framing skips a blank-node root (and any root absent from the index)
rather than crash. Blank-node subjects still embed fine when _referenced_ from
a root; they just cannot _be_ one – select roots accordingly
(`selectByClass` in `@lde/search-pipeline` already excludes them).

`projectRoots` yields a **bare** `SearchDocument`. Pairing each document with the
`SearchType` it belongs to, so the write side can fan a mixed stream out to
per-type collections, is a routing concern owned by the pipeline glue – see
`@lde/search-pipeline`’s `searchStages` and multi-collection writer – not the
projection. One stage per root type keeps `@lde/search` pipeline-free.

`projectRoots` **consumes the quads once** – a single scan builds the subject
index the roots frame off – and so accepts any `Iterable<Quad>`, not just a
materialized array. A caller merging several readers can pass a chained
generator instead of building a third full array at the projection peak:

```ts
projectRoots(
  (function* () {
    yield* registerQuads;
    yield* dkgQuads;
  })(),
  roots,
  schema,
  DATASET,
);
```

## Locales

`locales` declares the languages a `text` field wants **indexed** (`und` =
untagged literals). It drives the two per-locale, in-memory fanouts –
`searchable` and `sortable` – but **not** display, which preserves every
language present:

- `output` → `title_<lang>` for **every** language the data carries (`title_nl`,
  `title_en`, `title_fr`, `title_und`, …), accents preserved. Display is stored
  `index: false` (on disk, off RAM), so extra languages cost nothing – a value
  in a language outside `locales`, or an untagged one, still renders rather than
  collapsing to a bare IRI. One un-indexed regex field (`${name}_<lang>`, see
  `displayFieldPattern`) captures them all;
- `searchable` → `title_search_nl`/`title_search_en` (folded; one field per
  locale lets a query `query_by` them and rank the user’s language higher, and
  lets a language that needs a dedicated tokenizer set its own stemming `locale`
  in the engine schema);
- `sortable` → `title_sort_nl`/`title_sort_en` (folded, so a locale-switching UI
  sorts on the active language).

A field with `searchable` but no `output` is **search-only** – folded and stemmed
for retrieval but never rendered (e.g. a creator searched here but shown via a
separate label). **Only listed locales are indexed** (searched and sorted); a
literal whose language tag is not in `locales` is still **displayed** but not
matched or sorted on. Display fields are **omitted, never empty**, when a document
lacks that language, and the per-locale search/sort fields likewise, so declare
them optional in the engine schema and sort with `missing_values: last`. A
deployment that wants to bound the displayed languages narrows them upstream
(e.g. selecting a language subset in its CONSTRUCT query), since preservation is
the default.

Folding the search fields is what lets diacritic-insensitive matching and
stemming coexist. A search engine on its **default** locale typically folds case
and diacritics for you; enabling a language’s **stemming** switches it to ICU
tokenization, which **preserves** diacritics – at which point `fold()` (from
[`@lde/text-normalization`](../text-normalization)) is what keeps matching
diacritic-insensitive. Stemming is rules-based and can mangle proper nouns (the
Dutch stemmer reduces the city `Bergen` to `berg`), so enable it on free-text
fields and keep proper-noun facets on a separate, unstemmed field.

## Querying

The search fields are stored already case- and diacritic-folded, so **the query
must be folded the same way** with the same `fold()` before it reaches the engine,
or index and query normalize differently and matches silently miss. This contract
holds for **any** consumer, including an API built on this package – which is why
engine adapters and surfaces compile through the shared `SearchQuery` IR and the
`physicalFields` convention rather than re-deriving field names.

Queries are **always validated**: the port contract requires every engine
adapter to reject a structurally invalid `SearchQuery` (`assertValidQuery`) –
unknown or non-`filterable` fields in `where`, an operator not matching the
field’s kind, non-`facetable` facet requests – no matter which surface or
policy produced it. A typed surface like GraphQL makes most of these
unrepresentable; the port enforces them for everyone else (deployment
`queryDefaults`, in-process callers, weaker-typed surfaces).

## Typed results

An engine is **bound to the whole `SearchSchema` at construction** – like
every other schema consumer (`projectRoots(quads, roots, schema, type)`,
`buildGraphQLSchema(schema)`): the adapter factory takes the deployment’s
declaration, so a query can never meet the wrong index, and deployment-level
concerns (the label cache, cross-type search, facet batching) have one home.
Where each type physically lives is the **adapter’s** to decide – it derives a
collection/index name from the type, by its own engine’s naming conventions,
and a deployment only overrides that where it must. A search names its type per
call. Because `searchSchema()` captures the declared types as a literal
tuple, `search()` accepts **only the deployment’s own types** (a foreign type
is a compile error) and returns facet/document keys typed by the type passed
– no caller-side generics:

```ts
// No `collections`: each type reads the collection the adapter names it,
// which is the one its writer builds. Pass `collections` only to override.
const engine = createTypesenseSearchEngine(client, schema);

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
today will run a **SHACL-generated** one tomorrow – the model, the ports and the
IR stay; only schema-authoring gets automated.
