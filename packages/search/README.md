# @lde/search

Engine-agnostic search projection for RDF-backed pipelines. Two steps, no
engine and no vocabulary baked in:

1. **`frameByType(quads, rootType)`** — frame the result of a SPARQL `CONSTRUCT`
   into one JSON-LD IR node per subject of `rootType`.
2. **`projectDocument(node, fields, derivations)`** — turn that IR node into a
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
import { projectDocument, irisOf, type FieldSpec } from '@lde/search';

const fields: FieldSpec[] = [
  // → title_nl, title_en, title_search (folded), title_sort
  {
    name: 'title',
    path: 'http://purl.org/dc/terms/title',
    kind: { type: 'langText', locales: ['nl', 'en'], search: true, sort: true },
  },
  // → publisher (IRI facet)
  {
    name: 'publisher',
    path: 'http://purl.org/dc/terms/publisher',
    kind: { type: 'facet', iri: true },
  },
  // → size (int)
  { name: 'size', path: 'urn:dr:size', kind: { type: 'number' } },
];

const doc = projectDocument(node, fields, [
  (document, framed) => {
    document.class_count = irisOf(framed, 'urn:dr:class').length;
  },
]);
```

**Kinds**

| kind       | emits                                                                                                          |
| ---------- | -------------------------------------------------------------------------------------------------------------- |
| `langText` | `_nl`/`_en` (locales), `_search` (folded), `_sort`, `_name` (single display)                                   |
| `facet`    | the field as a deduped array; `iri` reads `@id`; `search` adds a folded `_search`; `transform` rewrites values |
| `number`   | a numeric scalar; `date` parses an ISO date-time to unix seconds                                               |

## Why a spec

The field spec's vocabulary mirrors SHACL on purpose: `path` is `sh:path`, and
the kind is derivable from `sh:datatype` / `sh:nodeKind` / `sh:maxCount` plus
search annotations. So the same projection engine that runs a hand-written spec
today will run a **SHACL-generated** spec tomorrow — the engine and the IR stay;
only spec-authoring gets automated. Nothing is thrown away.
