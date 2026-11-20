# 44. Search a reference facet that stores no labels by its targets

Date: 2026-11-20

## Status

Accepted

Amends [ADR 43](0043-select-a-reference-facets-matches-by-the-labels-its-documents-carry.md):
a reference facet without a label-match companion takes a query again.

## Context

ADR 43 matches a query on a reference facet against the labels its documents
store, and refused a query on every reference facet that stores none: one that
`derive`s its values or reads them with `from`, an inline reference’s
identity, and one whose label source derives its label. Before it, all of
these took a query, matched by the free-text search of the types they name.

In Linked Open Limburg that took the search box off five facets that clients
use to find one value in a long list: a work’s `contributor`, `dataset`,
`isPartOf` and `publisher`, and an occupation’s `dataset`. `publisher` and
`isPartOf` derive their values from the work’s Dataset document, `dataset` is
provenance read with `from`, and `contributor` is faceted on an inline
reference’s identity. None of them states a label on the work to match.

## Decision

A reference facet of the type’s own whose values have a label source takes a
query again (`isQueryableFacet`). How it is matched depends on what its
documents store (`facetMatchesLabels`):

- **With a label-match companion**, as ADR 43 decided.
- **Without one**, step one searches the collection of every type the
  reference names with that type’s own free-text search, as before ADR 43,
  but with `maxFacetQueryCandidates` shared evenly across the types, so step
  two sends no more count searches than on the other path. Step two counts
  each candidate on the facet field, as for the companion.

`facetQueryMatchOf` names the path a facet takes – `values`, `labels` or
`targets` – and the engine, the GraphQL cost and the `query` argument’s
description all switch on it.

A faceted leaf still takes no query: it never had one in a client, and its
nested path stores no labels either.

A query on a facet without the companion costs one more per target type in
GraphQL, since step one sends one search per type.

## Consequences

- The five facets take a `query` again, with no change to their documents and
  no reindex.
- On those facets the query has the weakness ADR 43 fixed for the others: its
  candidates are the referents most relevant to the text, not the ones the
  counted documents carry most, so a common match can be missed when many
  referents match. That matters little for a facet with few values, such as
  `publisher` or `dataset`, and more for one like `contributor`.
- They match alternate names and labels only the target’s collection holds,
  which a facet with a companion does not.
- Two matching paths now live side by side, chosen in one place.

## Alternatives considered

- **Store labels for these facets too**, by having the extraction read the
  labels of referents a `derive` or `from` produces. That would give them
  ADR 43’s matching, but those values are computed after extraction, from
  documents the extraction does not see. It remains the way to close the gap
  ([lde#1058](https://github.com/ldelements/lde/issues/1058)).
- **Leave them without a query** and have clients list the values with a
  larger `limit`. Workable for a facet with a few dozen values, not for
  `contributor`.
