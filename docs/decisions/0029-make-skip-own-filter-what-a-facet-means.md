# 29. Make skip-own-filter what a facet means

Date: 2026-10-23

## Status

Accepted

Amends [ADR 5 (Batch facet queries through the engine port)](./0005-batch-facet-queries-through-the-engine-port.md),
whose section “Grouping stays in the surface” it replaces, and
[ADR 4 (Search API GraphQL surface)](./0004-search-api-graphql-surface.md),
which introduced skip-own-filter as a GraphQL concern. Keeps the ownership rules
of [ADR 18 (Filter across several fields with one clause)](./0018-filter-across-several-fields-with-one-clause.md)
and [ADR 19 (Filter across collections through declared joins)](./0019-filter-across-collections-through-declared-joins.md).

## Context

A facet counts with its own filter removed, so a multi-select facet still
offers the values a user has not picked. ADR 4 put that removal in the GraphQL
surface, and ADR 5 kept the grouping of facets into queries there. ADR 5 needed
the port to batch queries; where skip-own-filter lived was taken over from ADR
4, not weighed.

Linked Open Limburg found what that placement costs (limburg/lol#198): select a
dataset, add a date range that leaves it no documents, and the dataset’s
bucket disappears, taking the checkbox that would deselect it. The surface
had dropped the dataset filter before the engine saw the query, so the
engine had no way to know the value was selected. The engine leaves out a
value with count 0, and a value past the bucket cap (`maxFacetValues`).

The first fix added `SearchQuery.facetValues` to the port: values the engine
must report whatever their count, which the surface filled with what it had
just removed. It worked, but it widened the port with a field that exists only
to undo what the layer above did, and every future surface would have had to
repeat the removal and the hand-back.

The search APIs that offer this treat it as the engine’s concern. Algolia
computes disjunctive facets from the refinements in the query; Elasticsearch
and Solr exclude a tagged filter per facet (`post_filter` and filter
aggregations, `{!ex=tag}`). None of them asks the caller to rewrite the query
and then report what it removed.

## Decision

### A facet counts without its own clause, and reports what that clause selects

At the port, `SearchQuery.facets` means:

> A facet counts the documents under every `where` clause except its own, and
> reports every value its own clause selects.

A selected value no other clause leaves a document comes back with count 0,
and a selected value past the bucket cap with its real count. A surface sends
the user’s query unchanged. Ownership follows ADR 18: a clause is a facet’s
own when every criterion in it names that field, on the searched type. A
clause spanning several fields is nobody’s own, and a criterion reached
through a join is a different axis (ADR 19).

An `in` selection names its values and an `is` selection its boolean. A range
names none; its facet still counts without it, which is what a range facet’s
`matching` extent is.

### One planner, shared by every adapter

`facetSearches(query)` in `@lde/search/adapter` returns the fewest searches
that compute a query’s facets under this rule: one search for every facet
without a clause of its own, sharing the query’s `where`, and one search per
own-filtered facet with its own clauses removed and the values they selected.
An adapter sends those searches and reports the selected values; the planner
fixes which clause belongs to which facet, so engines cannot disagree. The
contract suite (`@lde/search/testing`) checks the rule against every adapter.

The Typesense adapter answers `search()` with the hits search carrying the
facets that share its `where`, plus one facet-only search per own-filtered
facet, all in one `multi_search`. It reports a selected value missing from a
complete facet at count 0, and counts one missing from a capped or
policy-narrowed facet with a search of its own.

### The surface batches, and no longer rewrites

`searchFacets` stays. The GraphQL surface still needs facets over more than
one query in a round-trip: over the listing’s filters (`matching`), and over
the whole collection for a range facet’s `all` extent. Its loader now sends at
most those two queries, each with `where` intact.

`facetValues` and its validation reasons are not added.

## Consequences

- A selection is always among its facet’s buckets, on every surface and every
  engine, with no field in the query to request it.
- A default a surface adds to `where` – a valid-only `status` – is a selection
  like any other: its facet counts across every value, as before, and now also
  reports the default’s values as selected. A range default on a numeric field
  is dropped for that field’s facet in `matching` and `all` alike, so the two
  extents agree.
- `searchFacets` fails a query as a whole: when one of the searches an engine
  needs for it fails, all of that query’s facets degrade. Before, the surface’s
  own grouping let the other facets of the same query survive.
- A caller cannot ask for a facet counted _with_ its own clause: drill-down
  counts, where selecting narrows the facet itself. When a deployment needs
  that, a per-facet option on the query can name it, for example
  `facets: ['publisher', { field: 'keyword', countsUnder: 'allFilters' }]` with
  `countsUnder: 'otherFilters'` the default. It is not built until something
  needs it.
- **Breaking** for a `SearchEngine` implementation: `search()` and
  `searchFacets()` must apply the rule, which the contract suite now checks. An
  engine that counted facets under the full `where` returns different buckets.
