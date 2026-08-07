# 18. Filter across several fields with one clause

Date: 2026-08-07

## Status

Accepted

Amends [ADR 3 (Search API core query model)](./0003-search-api-core-query-model.md)
and [ADR 4 (Search API GraphQL surface)](./0004-search-api-graphql-surface.md);
settles the facet interaction left open by
[ADR 5 (Batch facet queries through the engine port)](./0005-batch-facet-queries-through-the-engine-port.md).

## Context

“Show me everything related to this entity” had no answer. A `where` clause named
exactly one field, and in Linked Data one conceptual filter routinely maps to
**several predicates**: an agent is `creator` or `contributor` or `publisher`, a
place is `contentLocation` or `locationCreated`. A consumer building an entity
landing page had to issue one query per predicate and merge client-side, losing a
correct `total`, ranking and facet counts.

Typesense `filter_by` already supports `||`, so the disjunction rides the same
round-trip. The work was in the model and the contract.

## Decision

### One clause model, for one field or many

A clause is a **disjunction of criteria**, and a criterion is one field with one
operator:

```ts
type Criterion = { field; in } | { field; range } | { field; is };
interface Filter {
  readonly or: readonly Criterion[];
} // OR across criteria
// SearchQuery.where: readonly Filter[]                    // AND across clauses
```

The point is that this is the **only** clause shape. An ordinary single-field
filter is not a different thing that a cross-field filter was added alongside –
it is this same clause carrying one criterion (`filterOn` builds it). So there is
no second variant to discover: an adapter that iterates `or` serves one
criterion and five by the same code, and `assertValidQuery` validates one rule
rather than branching on which kind of clause it has. A second engine adapter
cannot silently ignore a shape it never learned about, because there is only one.

Two capabilities fall out of criteria carrying their own operator rather than the
clause carrying it: a clause may mix kinds (`creator in […]` OR `size > 100`),
and it may name one field twice – the only way to express “smaller than 10 **or**
larger than 100”, a range pair no value list can collapse.

### Flat, never a tree

`where` is a conjunction of disjunctions and stops there. A boolean tree would
make skip-own-filter undefinable: “remove this facet’s own clause” has no answer
once a clause can be nested inside an `OR`. The same ceiling is what Algolia’s
`facetFilters` (array-of-arrays, inner OR, outer AND) settled on.

### A clause is a facet’s own when every criterion names that field

Skip-own-filter (ADR 5) removes a facet’s own clause so the facet still offers
the other values the user could pick. Ownership therefore follows **which axis a
clause constrains**, not how many criteria it carries:

- every criterion on one field – the ordinary filter, and equally a same-field
  disjunction (`or: [{ created: { max: … } }, { created: { min: … } }]`, or a
  multi-select spelled as alternatives) – **is** a selection on that axis, so it
  drops. Keeping it would compute the facet with the user’s own selection
  applied, offering back only what they already picked;
- a clause spanning several fields is **nobody’s own**: the user constrained the
  document as a whole, never one axis, so nothing on any single facet is theirs
  to widen. It stays whole.

That keeps each facet **complete on its own field** – every value it offers is one
the user can pick, with the count they will get. Both alternatives break it for
the cross-field case: dropping the clause’s own disjunct computes the facet over a
different set than the page is showing (on an entity page, hiding the very entity
the page is about); dropping the clause entirely counts the unfiltered corpus
while sibling facets stay filtered.

Since no facet owns a cross-field clause, one never splits the facet batch.

### The surface names both combinators

`<Type>Where` keeps its keyed shape – sibling keys AND, each typed by its field’s
kind – and gains two combinator keys:

```graphql
input ThingWhere { id: StringFilter  created: DateRange  …  or: [ThingCriterion!]  and: [ThingWhere!] }
input ThingCriterion @oneOf { id: StringFilter  created: DateRange  … }
```

```graphql
where: { status: …, material: … }                                  # AND
where: { material: …, or: [{ creator: $a }, { contributor: $a }] }  # OR, ANDed with material
where: { and: [{ or: [{ creator: $a }, { contributor: $a }] },      # two disjunctions
               { or: [{ contentLocation: $p }, { locationCreated: $p }] }] }
```

Three properties decided it:

- **Fields are named one way – as keys**, at every level. A draft naming them
  through a generated enum inside a cross-field key meant two vocabularies for
  one concept.
- **Neither combinator is positional.** A draft where `where` was a nested list
  (`[[…]]`, inner OR, outer AND) was rejected: the two differ by one bracket,
  both parse, and results differ silently – and since a list reads as
  _alternatives_, the likely slip is the wrong way round.
- **`@oneOf` keeps a criterion an atom.** A two-key criterion would be a
  conjunction nested inside an `or`, which the flat IR cannot hold; the schema
  rejects it instead of a runtime check. Requires graphql-js ≥ 16.9.0.

`and` carries further `Where`s rather than a separate clause type. It is safe to
be recursive because a conjunction inside a conjunction flattens, and the one
shape that would not – an `and` inside an `or` – is unreachable: `or` holds only
`@oneOf` criteria. So two input types serve every depth, and a reader never has
to work out how a “clause” differs from a `where`.

`and` and `or` join `id` as reserved field names (`validateSearchType`): a
declared field of either name would shadow the combinator. Neither is plausible
as an RDF property name, and a logical field name is deliberately not derived
from its predicate IRI, so a deployment needing one can rename it.

## Consequences

- One query answers “documents referencing this IRI through any of these
  predicates”, with a correct `total`, ranking and facet counts, in one engine
  round-trip: `(id:=[…] || creator:=[…] || about:[…]) && …`.
- `or: [{ id: $f }, { creator: $f }, { about: $f }]` states “the entity’s own
  record **plus** everything referencing it”: the entity landing page in one
  query.
- Breaking IR change: a clause is `{ or: [...] }` rather than a field and an
  operator.
- No breaking surface change: the keyed form is unchanged, `or` and `and` are
  additive.
- The keyed form and a one-criterion `or` are two spellings of one filter.
  Accepted: both compile to the identical clause, so they cannot diverge.
- Cross-field `range` and `is` work throughout, so no capability is reserved to
  membership.
