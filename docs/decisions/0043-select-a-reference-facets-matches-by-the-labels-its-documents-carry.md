# 43. Select a reference facet’s matches by the labels its documents carry

Date: 2026-11-20

## Status

Accepted

Amends [ADR 38](0038-search-a-document-by-its-referents-labels.md) and
[ADR 39](0039-apply-a-label-sources-transforms-to-its-referents.md): a
facetable reference reads and transforms its referents’ labels too.

## Context

A query on a reference facet (`facetQueries`) found its candidates by
searching the collections of the types the reference names, ranked by text
relevance, at most 250 per type. It could not know which referents the
counted documents carry. In Linked Open Limburg, 5056 terms match “petrus”,
so the `about` values used most never became candidates: the facet returned
48 buckets with counts from 9 down to 1, and missed “Timor (Petrus
Regout/Sphinx)” on 69 works
([lde#1102](https://github.com/ldelements/lde/issues/1102)).

Counting every match would make the work grow with the data, which
[ADR 12](0012-bound-memory-by-the-unit-of-work-not-the-input.md) rules out.
The selection has to rank by count, over the documents counted. Typesense 30.2
offers nothing that matches a referent by its label while bucketing by its id:

- A reference facet (`facet_by=$terms(label)`) rejects `facet_query`, and
  counts the referent documents rather than the referring ones.
- A nested `object[]` with `facet_return_parent` buckets by label, so two
  referents sharing a label merge into one bucket with one id.
- Filtering on one element of an object array selects the right documents,
  but the facet then counts all their referents.

## Decision

The label goes into the facet value itself, and only selects; the facet field
still counts.

- **A label-match companion.** A facetable reference whose label sources read
  their label from a path (`facetMatchesLabels`) stores `${name}_match` – or
  `${name}_id_match` for a local lookup – with one value per referent the facet
  counts, after any facet policy: the labels the referring graph states for it,
  then its id (`labelMatchValue`). Punctuation in a label becomes a space; the
  id sits behind a separator and a guard that no query starts with.
- **The extraction reads the labels**, as it does for a `searchable`
  reference, and the target’s transforms run on them (ADR 39). A local lookup
  reads them off the endpoints its target’s declaration projected.
- **Step one is `facet_query` on the companion**, over the facet’s search –
  the query’s documents without the facet’s own filter – returning at most
  `maxFacetQueryCandidates` values, highest count first. Their ids are the
  candidates.
- **Step two is unchanged**: each candidate is counted on the facet field.
- **Fewer facets take a query.** An inline reference’s identity and a faceted
  leaf store no labels beside their ids, so `isQueryableFacet` refuses them, as
  it does a reference whose label source derives its label.

## Consequences

- The buckets are the matching referents the counted documents carry most,
  with exact counts. `totalValues` is reported when step one returned every
  matching value.
- Only the labels on the documents match. An alternate name, a label only an
  enrichment supplies to the target’s collection, or a referent stated by IRI
  alone is not found by a query, though the facet without one still counts it.
  Labels for such referents are what remains of
  [lde#1058](https://github.com/ldelements/lde/issues/1058).
- A referent whose documents state different labels is split over several
  companion values. Its count stays exact, but when more values match than the
  cap holds it ranks per label, so it can lose its place to a smaller referent
  labelled the same everywhere.
- Every facetable reference with a label path makes the extraction read one
  more hop, and every document carries one more field. A collection needs a
  reindex, and an in-place one a rebuild, before a facet query finds anything.

## Alternatives considered

- **Count on the companion alone, without step two.** One search instead of
  up to 51, but exact only if every document stated the same label for a
  referent and none stated it by IRI alone. ADR 38 counts 1103 of the 1291
  works about “boerenbont” carrying the label.
- **Copy the label from the target’s collection at index time**, so every
  document carries the same one. That would make the companion’s counts exact,
  but ADR 39 rejected the ways of doing it, and a lookup in the live collection
  lands a label one run late and leaves a skipped dataset’s copies stale.
- **Keep searching the target’s collection, filtered to referents the
  documents carry** through a join. It narrows the candidates but still ranks
  them by text, and works only for a `joinable` reference.
