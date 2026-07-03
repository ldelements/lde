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
  [`@lde/search-typesense`](../search-typesense);
- **API surfaces** drive it, parsing client input into `search(SearchQuery)`
  calls: [`@lde/search-api-graphql`](../search-api-graphql), with a REST
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

One field, four consumers — that is why the model is unified: a field’s `kind`
plus capability flags (`searchable` / `filterable` / `facetable` / `sortable` /
`output`) describe projection, the engine collection schema, the query semantics,
and the API output in a single place.

## Terminology

The model has three levels, with analogues in SHACL (one possible source — see
[Why a declarative model](#why-a-declarative-model)) and GraphQL (one of the
surfaces):

| Term           | What it is                                                                                                      | SHACL          | GraphQL     |
| -------------- | --------------------------------------------------------------------------------------------------------------- | -------------- | ----------- |
| `SearchField`  | One queryable field: a `kind`, the IR `path` it projects from, and the capability flags it opts into            | property shape | field       |
| `SearchType`   | One root type’s complete declaration: its `type` IRI plus its fields and derivations                            | NodeShape      | object type |
| `SearchSchema` | The whole search declaration: every `SearchType`, keyed by `type` IRI — build one with `searchSchema(...types)` | shapes graph   | schema      |

`projectGraph` and the GraphQL surface consume a `SearchSchema` (projecting
every type in one pass, resp. emitting one root query field per type); the
engine port executes one `SearchType` at a time.

## Field model

The mapping is data, not code. Each field declares its `kind`, the IR `path` to
read (omit it for a **derived** field, populated by a `derivation`), and the
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
  type: 'http://www.w3.org/ns/dcat#Dataset',
  fields: [
    // → title_nl, title_en, title_search_nl/_en, title_sort_nl/_en
    {
      name: 'title',
      path: 'http://purl.org/dc/terms/title',
      kind: 'text',
      localized: true,
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
      ref: { type: 'Organization', strategy: 'labelOnly' },
    },
    // → size (int)
    { name: 'size', path: 'urn:dr:size', kind: 'integer', sortable: true },
    // derived field (no path): populated by the derivation below
    { name: 'classCount', kind: 'integer', sortable: true },
  ],
  derivations: [
    (document, node) => {
      document.classCount = irisOf(node, 'urn:dr:class').length;
    },
  ],
});

for await (const document of projectGraph(quads, searchSchema(DATASET))) {
  // one flat search document per matching subject, streamed
}
```

`defineSearchType` captures the declaration as a literal (what
`as const satisfies SearchType` would do manually, with nothing to remember),
so typed facet/output keys can be derived from it — see
[Typed results](#typed-results) and `@lde/search-api-graphql`.

**Kinds** (`FieldKind`): `text`, `keyword`, `integer`, `number`, `boolean`,
`date`, `reference`. The Typesense/engine vocabulary and the GraphQL types are
_derived_ from the kind by the adapter and the surface — never declared here.

| kind                 | `where`              | facet | sort             | output                          |
| -------------------- | -------------------- | ----- | ---------------- | ------------------------------- |
| `text` (`localized`) | – (feeds free text)  | –     | yes (per-locale) | best-first language list        |
| `keyword`            | `in` (membership)    | yes   | –                | string / `string[]`             |
| `reference`          | `in` (membership)    | yes   | –                | labelled reference (id + label) |
| `integer` / `number` | `range { min, max }` | yes   | yes              | number                          |
| `date`               | `range` (inclusive)  | yes   | yes              | ISO 8601 string (surface)       |
| `boolean`            | `is`                 | yes   | –                | boolean (absent = false)        |

## Projection

`projectGraph` is fully streaming: subjects are grouped and framed one at a time
and documents are yielded as produced, so beyond a subject index memory stays
flat at scale (framing the whole graph at once is roughly O(N²)). Duplicate
triples are collapsed first, because some SPARQL engines (e.g. QLever) do not
deduplicate `CONSTRUCT` output. The IR carries no `@context`, so a `derivation`
reading it sees full predicate IRIs with language tags preserved.

## Locales

`locales` is the **single** list of languages a localized `text` field projects;
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
separate label). **Only listed locales are indexed**; a literal whose language tag
is not in `locales` (or has no tag) is not projected at all. Per-locale fields are
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

## Typed results

The `SearchEngine` port is loosely typed by default: facet and document keys
are plain strings. That is the correct contract for an adapter (which cannot
know your fields) and for a surface that builds queries from client input at
runtime. An **in-process caller that knows its search type at compile time**
should narrow the engine with `engineFor` — same instance, zero runtime cost:

```ts
import { engineFor } from '@lde/search';

const datasetEngine = engineFor(DATASET, engine);

const result = await datasetEngine.search(query, DATASET);
result.facets.publisher; // typed: only DATASET’s facetable fields are keys
result.facets.publsher; // compile error (typo)
result.hits[0].document.title; // typed: only DATASET’s output fields are keys
await datasetEngine.search(query, OTHER_TYPE); // compile error (wrong type)
```

This only works when the search type was declared with `defineSearchType` (or
captured `as const satisfies SearchType`); a plain `: SearchType` annotation
widens the field literals away. The underlying pieces (`EngineFor`,
`FacetFieldsOf`, `OutputFieldsOf`) are exported for annotating your own
signatures.

## Why a declarative model

The vocabulary mirrors SHACL on purpose: `path` is `sh:path`, `array` is
`sh:maxCount`, `required` is `sh:minCount`, `localized` is `sh:languageIn`, `ref`
is `sh:class`/`sh:node`. So the same core that runs a hand-written `SearchSchema`
today will run a **SHACL-generated** one tomorrow — the model, the ports and the
IR stay; only schema-authoring gets automated.
