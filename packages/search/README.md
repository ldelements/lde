# @lde/search

Engine-agnostic search projection for RDF-backed pipelines. **`projectGraph`**
streams the result of a SPARQL `CONSTRUCT` into flat search documents, with no
engine and no vocabulary baked in. Internally it does two things per subject of
a root type: frame its one-hop subgraph into a JSON-LD IR node, then project
that node into a flat document from a **declarative field spec**.

An engine adapter (e.g. [`@lde/search-typesense`](../search-typesense)) then
writes those documents to a search backend.

```ts
import { projectGraph, type Projection } from '@lde/search';

const projection: Projection = {
  /* type + field spec — see below */
};

for await (const document of projectGraph(quads, [projection])) {
  // one flat search document per matching subject, streamed
}
```

`projectGraph` is fully streaming: subjects are grouped and framed one at a time
and documents are yielded as they are produced, so beyond a subject index memory
stays flat at scale (framing the whole graph at once is roughly O(N²)). Duplicate
triples are collapsed first, because some SPARQL engines (e.g. QLever) do not
deduplicate `CONSTRUCT` output. The IR carries no `@context`, so a `derivation`
reading it sees full predicate IRIs with language tags preserved.

## Projection

The mapping is data, not code. Each field declares the IR `path` to read and a
`kind`; the conventions (per-locale split, diacritic folding via
[`@lde/text-normalization`](../text-normalization), facet arrays, numeric
coercion) are applied for you. Computed fields are `derivations` — hooks that
read the node and set fields the kinds can't.

```ts
import { projectGraph, irisOf, type Projection } from '@lde/search';

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
        display: true,
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
    (document, node) => {
      document.class_count = irisOf(node, 'urn:dr:class').length;
    },
  ],
};

for await (const document of projectGraph(quads, [projection])) {
  // …
}
```

**Kinds**

| kind       | emits                                                                                                                                                    |
| ---------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `langText` | per locale (see below), each opt-in: `_${locale}` display with `display`, `_search_${locale}` folded with `search`, `_sort_${locale}` folded with `sort` |
| `facet`    | the field as a deduped array; `iri` reads `@id`; `search` adds a folded `_search`; `transform` rewrites values                                           |
| `number`   | a numeric scalar; `date` parses an ISO date-time to unix seconds                                                                                         |

## Locales

`locales` is the **single** list of languages a `langText` field projects;
`display`, `search` and `sort` are independent opt-in families that each fan out
over it (so a field emits exactly what it opts into):

- `display` → `title_nl`/`title_en` (accents preserved);
- `search` → `title_search_nl`/`title_search_en` (folded; one field per locale
  lets a query `query_by` them and rank the user’s language higher via
  `query_by_weights`, and lets a language that needs a dedicated tokenizer set
  its own `locale` in the schema);
- `sort` → `title_sort_nl`/`title_sort_en` (folded, so a locale-switching UI
  sorts on the active language).

A field with `search` but no `display` is **search-only** — folded and stemmed
for retrieval but never rendered (e.g. a `publisher` searched here but shown via
a separate label).

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

A literal with no `@language` tag matches no locale, so it is not projected. Tag
your source literals (or pre-process them) for the languages you index.

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
this package: index-time and query-time folding must use the same `fold()`, or
non-decomposing terms silently miss.

## Why a spec

The field spec's vocabulary mirrors SHACL on purpose: `path` is `sh:path`, and
the kind is derivable from `sh:datatype` / `sh:nodeKind` / `sh:maxCount` plus
search annotations. So the same projection engine that runs a hand-written spec
today will run a **SHACL-generated** spec tomorrow — the engine and the IR stay;
only spec-authoring gets automated. Nothing is thrown away.
