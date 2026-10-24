# 29. Make skip-own-filter what a facet means

Date: 2026-10-23

## Status

Accepted

Amends [ADR 5 (Batch facet queries through the engine port)](./0005-batch-facet-queries-through-the-engine-port.md),
replacing its section “Grouping stays in the surface”, and
[ADR 4 (Search API GraphQL surface)](./0004-search-api-graphql-surface.md),
which put skip-own-filter in the GraphQL surface. Keeps the ownership rules of
[ADR 18 (Filter across several fields with one clause)](./0018-filter-across-several-fields-with-one-clause.md)
and [ADR 19 (Filter across collections through declared joins)](./0019-filter-across-collections-through-declared-joins.md).

## Context

A multi-select facet is counted without its own filter (skip-own-filter).
With `keyword: atlas` selected, the `keyword` facet still counts the other
keywords as if nothing were selected, so the user can add `kaarten` to the
selection. Every other filter still applies.

ADR 4 put skip-own-filter in the GraphQL surface: before sending a facet’s
query to the engine, the surface removed that facet’s own filter. ADR 5 left
it there when it moved batching into the engine port, without weighing where
it belonged.

Linked Open Limburg ran into the cost of that placement (limburg/lol#198). A
user selects a dataset, then adds a date range that matches none of that
dataset’s documents. The dataset’s bucket disappears from the facet, and with
it the checkbox to deselect it. The engine leaves out values with count 0, and
values past the bucket cap (`maxFacetValues`). It could not keep the selected
dataset, because the surface had removed the filter that selected it before
the engine saw the query.

The first fix added `SearchQuery.facetValues`: values the engine must report
whatever their count, which the surface filled with the values it had just
removed. That worked, but the port gained a field whose only job was to undo
what the surface had done, and every surface would have had to repeat both
steps.

Other search APIs put skip-own-filter in the engine. Algolia derives
disjunctive facets from the refinements in the query. Elasticsearch and Solr
let a facet exclude a tagged filter (`post_filter` with filter aggregations;
`{!ex=tag}`). None asks the caller to rewrite the query and then say what it
removed.

## Decision

### The port defines skip-own-filter

`SearchQuery.facets` now means:

> A facet counts the documents under every `where` clause except its own, and
> reports every value its own clause selects.

A surface sends the user’s query unchanged. A selected value that the other
clauses leave without documents comes back with count 0; one past the bucket
cap comes back with its real count.

A clause is a facet’s own when every criterion in it names that facet’s field
on the searched type (ADR 18). A clause spanning several fields belongs to no
facet, and a criterion reached through a join is on a different field
(ADR 19).

An `in` criterion selects its values, and an `is` criterion its boolean. A
`range` selects no values. Its facet is still counted without it, and that
count is the range facet’s `matching` extent.

### One planner for every adapter

`facetSearches(query)` in `@lde/search/adapter` plans the searches that
compute a query’s facets under this rule:

- one search, with the query’s `where` intact, for all facets without a clause
  of their own;
- one search per facet that has a clause of its own, with that clause removed,
  plus the values the clause selected.

Adapters run these searches and report the selected values. Because the
planner decides which clause belongs to which facet, engines cannot disagree
on it. The contract suite in `@lde/search/testing` checks the rule against
every adapter.

The Typesense adapter sends the planned searches in one `multi_search`, the
hits search carrying the facets without a clause of their own. When a selected value is missing
from a complete facet, the adapter adds it at count 0. When the facet was
capped or narrowed by a policy, the value may still have documents, so the
adapter counts it with an extra search.

### The surface batches but no longer rewrites

`searchFacets` stays, because the GraphQL surface still needs facets from two
queries in one round-trip: under the listing’s filters for `matching`, and over
the whole collection for a range facet’s `all` extent. Its loader sends at most
those two queries, each with `where` intact.

## Consequences

- A selected value always appears among its facet’s buckets, on every surface
  and engine, without the caller asking for it.
- A default that a surface adds to `where`, such as a valid-only `status`,
  counts as a selection. The `status` facet counts across all statuses, as
  before, and now also always reports `valid`. A range default on a numeric
  field is dropped for that field’s facet in both `matching` and `all`, so the
  two extents agree.
- When one of a query’s searches fails, `searchFacets` fails the whole query
  and all its facets degrade. Before, the surface split a query’s facets over
  separate queries, so the other facets survived.
- A caller cannot ask for a facet counted with its own clause applied, as
  drill-down navigation does, where each selection narrows the facet itself.
  If a deployment needs that, a per-facet option can express it:
  `facets: ['publisher', { field: 'keyword', countsUnder: 'allFilters' }]`,
  with `countsUnder: 'otherFilters'` as the default.
- **Breaking** for `SearchEngine` implementations: `search()` and
  `searchFacets()` must apply the rule, which the contract suite checks. An
  engine that counted facets under the full `where` now returns different
  buckets.
