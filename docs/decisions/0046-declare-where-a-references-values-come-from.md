# 46. Declare where a reference’s values come from

Date: 2026-11-27

## Status

Accepted

Extends [ADR 43](0043-select-a-reference-facets-matches-by-the-labels-its-documents-carry.md):
more reference facets store their referents’ labels, so fewer fall back on
[ADR 44](0044-search-the-target-types-for-a-facet-whose-documents-store-no-labels.md).

## Context

A facet query matches the labels a document stores beside each referent’s id
(ADR 43). A reference read off the graph has them: the extraction reads each
referent’s label beside it. A reference whose values a `derive` computes has
none, so its facet query searches the target types’ collections instead
(ADR 44). That search ranks candidates by text relevance and cannot tell which
referents the counted documents carry, which is the weakness ADR 43 fixed.

In Linked Open Limburg, two of the four facets on that fallback used `derive`
for something a declaration could say:

- `publisher` copies the dataset document’s `publisher`;
- `isPartOf` is the `schema:isPartOf` path without the dataset being indexed.
  It read the path into an internal `_isPartOf`, because `derive` and `path`
  exclude each other, and filtered it in a `derive`.

The other two get their values without a `derive`: `dataset` is declared
`from: 'dataset'`, and `contributor` is an inline reference faceted on its
`local` identity.

## Decision

A reference declares where its values come from, and each such source has
labels for them:

- **`from: { dataset: 'publisher' }`** copies a field of the dataset’s own
  document (`context.datasetDocument`), and the labels that field’s label-match
  companion stores there. The dataset type must declare the field with the
  same `kind`, storing plain ids rather than nested documents. Only a Root
  Type other than the dataset type copies, and without a `transform` of its
  own: the dataset’s document stores the values transformed already.
  `searchSchema` refuses every other copy.
- **`excludeDataset: true`**, on a reference read from a `path`, leaves the
  dataset being indexed out of its values. The field is then an ordinary
  lookup, read and labelled like any other.
- **`from: 'dataset'`** takes the label of the dataset’s own document, on
  every type but the dataset type, whose documents are projected before it.
- **An inline reference’s `local` identity** takes the labels its entries’
  endpoints carry.

`facetMatchesLabels` decides from the declaration alone whether a facet stores
labels. A `derive`d reference never does: what it computes, nothing labels.

## Consequences

- A facet over the dataset, a copied field of it, a path without the dataset,
  or a `local` inline identity is matched by the labels its documents store,
  and ranks its matches by count.
- `derive` is left for values that are computed. A computed reference facet
  still falls back on ADR 44.
- Which facets store labels is visible in the schema; no facet query finds
  nothing because a computed value happened to carry no label.
- A copy takes the labels the dataset’s document stores, so a facet over it
  matches only where the dataset type’s own field is searched by label.
- A non-`local` inline identity stores bare ids, so its facet stays on ADR 44.
- A facet moving from ADR 44 to stored labels finds nothing on a document
  until it is reindexed.
- Like `datasetDocument` itself, a copy needs the dataset type’s document to
  keep the dataset’s IRI as its id: a dataset type declaring a `key` reaches no
  other stage.

## Alternatives considered

- **Let `derive` return labels** (`{ id, labels }`). Explicit, but every author
  of such a `derive` would source labels themselves, and a `derive` reading an
  internal field still has only that field’s ids.
- **Look labels up by IRI** among everything the projection read for the
  document and the dataset’s. No schema change, but whether a facet can match
  would depend on the data rather than the declaration, and the extraction
  would read labels for every internal reference in case a `derive` reads it.
- **Read labels from the target’s live collection at index time.** It would
  cover every referent, enrichment labels included, but lands a label one run
  late and leaves a skipped dataset’s copies stale (ADR 39).
