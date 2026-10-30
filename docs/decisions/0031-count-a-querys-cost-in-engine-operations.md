# 31. Count a query’s cost in engine operations

Date: 2026-10-28

## Status

Accepted

Amends [ADR 14 (Serve the search GraphQL API with GraphQL Yoga)](./0014-serve-the-search-graphql-api-with-graphql-yoga.md),
replacing graphql-armor’s cost limit in its “Limits”.

## Context

The handler rejected queries that scored above 5000 with graphql-armor’s
cost limit. That score follows a query’s shape: a scalar costs 1, an object
2, and each level of nesting multiplies by 1.5. It does not read arguments and
has no per-field hook.

In the search API, shape and work are unrelated. Every hit is one stored
document, so `birthPlace.postalCode` costs no more to serve than `id`. The
work is elsewhere: one search per root field, one fetch per selected joined
reference (per page of hits, not per hit), and one facet calculation per
selected facet key. graphql-armor scored none of these well. The Linked Open
Limburg browser’s regular `SearchCreativeWorks` query scored 5881, mostly
because `contributor` repeats the `creator` tree; leaving out every facet only
brought it to 5486. Each reference field a schema adds pushes such a query
further, so raising the limit only postpones the next rejection.

## Decision

The cost of a query is the number of engine operations it asks for, computed
with [graphql-query-complexity](https://github.com/slicknode/graphql-query-complexity)
from costs that `buildGraphQLSchema` puts on the fields as extensions:

- a search field costs 1;
- a `lookup` reference costs 1 per target type, because the engine fetches
  from each target’s collection;
- a facet key costs 1, and a range facet’s `all` extent 1 more, because it is
  computed over the whole collection in a query of its own;
- everything else costs 0: plain fields and inline references at any depth,
  introspection, and custom fields merged in.

The cost does not scale with `perPage`. A lookup fetches the referents of the
whole page in one request, and `maxPerPage` with `maxSearches` already bounds
the results. The default `maxCost` is 100: the costliest `creativeWorks`
query Linked Open Limburg’s schema allows – every field and facet, each
reference expanded until it would revisit a type – costs 48, and the Dataset
Register browser’s listing query costs 9.

A selection under `@skip` or `@include` counts whatever its condition, because
the engine fetches the lookups it selects either way: the projection leaves
those directives unevaluated, so a skipped field is never missing. The cost is
measured when the operation executes, not as a validation rule, because
measuring coerces the request’s variables.

## Consequences

- `maxCost` and `MAX_COST` keep their names but count operations now; a value
  tuned for graphql-armor (such as 5000) no longer limits anything in practice.
- A query over the limit is rejected with HTTP 200 and an execution error
  instead of a validation error, because the check runs at execution.
- Two selections of one lookup (for example under two aliases) are charged
  twice, although the engine merges them into one fetch. Over a reference with
  several targets, only the costliest target’s nested lookups count, although
  the engine runs those of every target. graphql-query-complexity scores an
  interface that way, and correcting either case would mean replacing its
  traversal with our own.
- graphql-armor stays for the depth limit.
