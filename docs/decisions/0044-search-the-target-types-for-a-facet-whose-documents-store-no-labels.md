# 44. Search the target types for a facet whose documents store no labels

Date: 2026-11-20

## Status

Accepted

Amends [ADR 43](0043-select-a-reference-facets-matches-by-the-labels-its-documents-carry.md).

## Context

ADR 43 selects a reference facet query’s candidates from the labels the counted
documents store, and therefore refused a query on every reference facet whose
documents store none. In Linked Open Limburg that took the `query` argument
from five facets that had one: `contributor`, an inline reference’s identity,
and `dataset`, `isPartOf` and `publisher`, whose values the run derives from
the dataset being indexed rather than reading them off the work’s graph. A
facet query exists to filter a facet’s buckets by text, so losing it on these
facets undid part of what it was added for.

## Decision

A reference facet with a label source takes a query wherever ADR 43 has no
labels to match, and step one there searches the collection of each type the
reference names, as before ADR 43.

- **Where the documents store labels** (`facetMatchField`), step one is
  `facet_query` on the label-match companion, as ADR 43 decided.
- **Everywhere else** – a facet whose values the run derives, an inline
  reference’s identity, a faceted leaf – step one searches each target type’s
  collection with that type’s own free-text search, at most
  `maxFacetQueryCandidates` ids per type.
- **Step two is the same for both**: each candidate is counted on the facet
  field.
- A GraphQL query on such a facet costs one more per target type, and each
  `query` argument’s description says which way it matches.

## Consequences

- `isQueryableFacet` admits every reference facet with a label source again.
- On these facets a query finds a referent by its alternate names, and by
  labels only an enrichment supplies, but picks its candidates by text
  relevance across the whole target collection, without knowing which the
  documents carry. That is the weakness ADR 43 fixed. It bites where more
  referents match than the cap holds: unlikely for a dataset or a publisher
  facet, likely for a person-valued identity such as LOL’s `contributor`,
  where “jan” can match 50 people none of whom contributed to the results,
  and the facet answers empty. Storing labels for these facets
  ([lde#1058](https://github.com/ldelements/lde/issues/1058)) would move them
  to ADR 43’s route.
- A GraphQL query on such a facet is charged one more per target type, while
  each target search may add up to `maxFacetQueryCandidates` count searches:
  the charge counts requests by their kind, not their number.
- A facet’s query matches differently depending on whether its documents store
  labels, so the same text can find an alternate name on one facet and not on
  another.

## Alternatives considered

- **Store labels for these facets too.** A derived value has no referent in
  the graph to read a label off, and an inline identity’s entries would each
  need a companion of their own.
- **Leave the search to the client**, as a search of the target type followed
  by a facet over the ids it returns. It works without a change here, but
  every client would have to compose it, and the facet’s `query` argument would
  mean nothing on half the facets.
