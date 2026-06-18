# @lde/search

Engine-agnostic search projection for RDF-backed pipelines. Two steps, no
engine and no vocabulary baked in:

1. **`frameByType(quads, rootType)`** — frame the result of a SPARQL `CONSTRUCT`
   into one JSON-LD IR node per subject of `rootType`.
2. **`projectDocument(node, projection, options?)`** — turn that IR node into a
   flat search document from a **declarative field spec**.

An engine adapter (e.g. [`@lde/search-typesense`](../search-typesense)) then
writes those documents to a search backend.

## Framing

```ts
import { frameByType } from '@lde/search';

for await (const node of frameByType(
  quads,
  'http://www.w3.org/ns/dcat#Dataset',
)) {
  // node has full-IRI keys, language tags preserved, e.g.
  // node['http://purl.org/dc/terms/title'] === [{ '@value': 'Titel', '@language': 'nl' }]
}
```

Each root subject's one-hop subgraph is framed **independently** and yielded one
at a time, so memory stays flat at scale (framing the whole graph at once is
roughly O(N²)). Duplicate triples are collapsed first, because some SPARQL
engines (e.g. QLever) do not deduplicate `CONSTRUCT` output. No `@context`, so
keys are full predicate IRIs.

## Projection

The mapping is data, not code. Each field declares the IR `path` to read and a
`kind`; the conventions (per-locale split, diacritic folding via
[`@lde/text-normalization`](../text-normalization), facet arrays, numeric
coercion) are applied for you. Computed fields are `derivations` — hooks that
read the node and set fields the kinds can't.

```ts
import { projectDocument, irisOf, type Projection } from '@lde/search';

const projection: Projection = {
  type: 'http://www.w3.org/ns/dcat#Dataset',
  fields: [
    // → title_nl, title_en, title_search_nl, title_search_en, title_sort_nl, title_sort_en
    {
      name: 'title',
      path: 'http://purl.org/dc/terms/title',
      kind: {
        type: 'langText',
        locales: ['nl', 'en'],
        search: true,
        sort: true,
      },
    },
    // → publisher (IRI facet)
    {
      name: 'publisher',
      path: 'http://purl.org/dc/terms/publisher',
      kind: { type: 'facet', iri: true },
    },
    // → size (int)
    { name: 'size', path: 'urn:dr:size', kind: { type: 'number' } },
  ],
  derivations: [
    (document, framed) => {
      document.class_count = irisOf(framed, 'urn:dr:class').length;
    },
  ],
};

const doc = projectDocument(node, projection);
```

**Kinds**

| kind       | emits                                                                                                                                             |
| ---------- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| `langText` | per locale (see below): `_${locale}` display (accents kept), `_search_${locale}` (folded, with `search`), `_sort_${locale}` (folded, with `sort`) |
| `facet`    | the field as a deduped array; `iri` reads `@id`; `search` adds a folded `_search`; `transform` rewrites values                                    |
| `number`   | a numeric scalar; `date` parses an ISO date-time to unix seconds                                                                                  |

## Locales

`locales` is the **single** list of languages a `langText` field projects, and
every family fans out over it: `title_nl`/`title_en` for display (accents
preserved), `title_search_nl`/`title_search_en` when `search` (folded; one field
per locale lets a query `query_by` them and rank the user’s language higher via
`query_by_weights`, and lets a language that needs a dedicated tokenizer set its
own `locale` in the schema), and `title_sort_nl`/`title_sort_en` when `sort`
(folded, so a locale-switching UI sorts on the active language).

Folding the search fields is what lets diacritic-insensitive matching and
stemming coexist. A search engine on its **default** locale typically folds case
and diacritics for you (Typesense v30, verified, even folds ø/æ/ß) — so there the
folding here is belt-and-suspenders. But enabling a language’s **stemming**
requires setting that language’s `locale` (e.g. `locale: 'nl'` + `stem: true` so
`huizen` matches `huis`), and a non-default locale switches the engine to ICU
tokenization, which **preserves** diacritics. At that point the engine no longer
folds them, and `fold()` is what keeps matching diacritic-insensitive. Stemming
is a per-field engine-schema choice (the consumer’s), and being rules-based it
can mangle proper nouns and place names — e.g. the Dutch stemmer reduces the city
`Bergen` to `berg`, colliding it with “mountain”.

Recommended split: enable stemming on the **free-text** search fields
(`*_search_${locale}`, descriptions, keywords) where morphological recall helps
(`verhaal` ↔ `verhalen`), and keep **place names and other proper-noun facets on
a separate, unstemmed field** (facets are exact-match anyway). That captures the
recall without the `Bergen`/`berg` collision in the facet. A `stem_dictionary`
can pin specific names if you need stemmed free-text without given collisions.

**Only listed locales are indexed.** A literal whose language tag is not in
`locales` is not projected at all — no display, no search, no sort field — so it
is invisible to the index. To index a language, add it to `locales`.

Per-locale fields are **omitted, never empty**, when a document lacks that
language, so declare them `optional: true` in the engine schema. At query time,
sort with `missing_values: last` to push documents lacking the active locale to
the end, and `query_by` all the per-locale search fields (weighting the user’s
locale higher) to keep cross-language recall.

Untagged literals (no `@language`) are dropped unless you set `untaggedLanguage`,
which interprets every untagged string as one language — e.g. a source whose
strings are all Dutch:

```ts
projectGraph(quads, projections, { untaggedLanguage: 'nl' });
```

## Querying

The search fields are stored already case- and diacritic-folded, so **the query
must be folded the same way** with the same `fold()` from
[`@lde/text-normalization`](../text-normalization) before it reaches the engine.
Otherwise index and query are normalized differently and matches silently miss
(the user sees no results, with no error). An engine on its default locale would
fold a raw query for you, but one set to a stemming locale (which preserves
diacritics) or a non-folding backend will not — so always fold, and matching
stays correct on any engine.

```ts
import { fold } from '@lde/text-normalization';

await client
  .collections(collection)
  .documents()
  .search({
    q: fold(userQuery),
    query_by: 'title_search_nl,title_search_en',
    query_by_weights: '2,1', // rank the user’s locale higher
  });
```

This contract holds for **any** consumer, including a search API built on top of
this package: index-time and query-time folding must use the same `fold()` (and
the same `FOLD_VERSION`), or non-decomposing terms silently miss.

## Why a spec

The field spec's vocabulary mirrors SHACL on purpose: `path` is `sh:path`, and
the kind is derivable from `sh:datatype` / `sh:nodeKind` / `sh:maxCount` plus
search annotations. So the same projection engine that runs a hand-written spec
today will run a **SHACL-generated** spec tomorrow — the engine and the IR stay;
only spec-authoring gets automated. Nothing is thrown away.
