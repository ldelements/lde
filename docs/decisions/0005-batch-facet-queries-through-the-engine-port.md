# 5. Batch facet queries through the engine port

Date: 2026-07-06

## Status

Accepted

Amends [ADR 3 (Search API core query model)](./0003-search-api-core-query-model.md);
refines the faceting described in
[ADR 4 (Search API GraphQL surface)](./0004-search-api-graphql-surface.md).

## Context

The keyed facets object of ADR 4 resolves each selected facet with its own
`where`-filter removed (skip-own-filter). Implemented as one `engine.search`
call per selected facet, a typical listing page fanned out into 1 listing
search + N facet searches – ~4–5× the engine round-trips of the pre-migration
direct-Typesense path, which computed the whole sidebar in a single
`multi_search`. Skip-own-filter only _changes_ the result for a facet whose
own field is actively filtered; for every other facet the dedicated query is
identical except for its `facet_by`.

## Decision

### A batch entry point on the engine port

`SearchEngine` gains `searchFacets(searchType, queries)`: a batch of
facet-only queries answered in one engine round-trip where the engine
supports one (Typesense: a single `multi_search`). Engines answer every
query facet-only – as if `limit: 0` and without ordering, whatever the query
carries – so hits are never transferred. The port contract (schema binding,
per-query structural validation) holds for every query in the batch.

### Per-query outcomes, not a whole-batch rejection

`searchFacets` returns one `FacetsOutcome` per query, positionally aligned:
`{ facets }` or `{ error }` (an `allSettled`-style union). A failure of one
query – e.g. one failed `multi_search` entry – is reported in place and never
discards its siblings’ facets; the promise rejects only for batch-level
failures (foreign type, invalid query, the transport itself). This preserves
the per-facet degradation granularity the per-facet resolvers had: the
surface degrades exactly the facets of a failed query to empty lists and
reports each via `onFacetError`.

### Grouping stays in the surface; batching transport stays in the adapter

The GraphQL surface owns skip-own-filter (a surface policy per ADR 4), so it
also owns the grouping: selected facet fields are collected per request
(a DataLoader batches the same-tick sibling resolvers) and grouped by their
**effective `where`** – facets whose own field is unfiltered share one query,
so the unfiltered browse collapses to a single facet query; each own-filtered
facet gets its own variant. The adapter owns the engine specifics: one
`multi_search`, one bundled reference-label lookup (or the in-memory label
cache) shared by the whole batch.

## Consequences

- A typical page load costs the listing search plus one batched facet
  round-trip (with the label cache on: exactly 2 Typesense round-trips),
  restoring the pre-migration behaviour.
- Breaking port change: every `SearchEngine` implementation must add
  `searchFacets`. The executable contract suite (`@lde/search/testing`)
  covers the new method.
- Deliberately not done: facets whose effective `where` equals the listing
  query’s could ride the listing search via `facet_by` (a 1-round-trip
  browse). That needs `GraphQLResolveInfo` selection-walking, and inside one
  `multi_search` the difference is negligible.
