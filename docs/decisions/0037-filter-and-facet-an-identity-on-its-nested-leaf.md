# 37. Filter and facet an identity on its nested leaf

Date: 2026-11-13

## Status

Accepted

Amends [ADR 24](0024-carry-data-on-a-reference-edge.md), section 4.

## Context

An inline reference naming an `identity` stored the ids of its endpoints twice:
in each entry, under the field the identity names (`contributor.contributor_id`
for Linked Open Limburg’s `contributor`), and in a flat companion beside the
reference (`contributor_id`), which plain filters and facets read. The flat copy
existed because a nested path was assumed not to be facetable per document.

[ADR 36](0036-facet-a-root-document-on-its-entries-leaves.md) showed it is.
Typesense flattens a leaf under an `object[]` into one list per document and
counts it that way: a work naming one agent in two roles counts once under that
agent. A container test pins this against Typesense 30.2.

## Decision

An inline reference with an `identity` filters and facets that identity’s leaf
inside each entry. The flat `${name}_id` companion is gone.

- **The leaf is the identity field’s own filter field.** For a plain lookup or
  an `idOnly` reference that is the field itself (`creator.creator`); for a
  `local` lookup, which stores an object, it is the id leaf beside that object
  (`contributor.contributor_id`). `physicalFields` names it as `filter`, which
  a membership filter reads, and as `facet` where no facet policy applies.
- **The identity field must be `filterable`.** Only an indexed leaf can be
  filtered or faceted, and `filterable` is what indexes it. `searchSchema`
  refuses an identity naming a field without it, rather than indexing the leaf
  behind the author’s back. A filterable nested field is single-valued, so an
  identity can no longer name an `array` field: an entry naming several
  endpoints is modelled as several entries, one per endpoint.
- **A facet policy keeps a top-level companion.** Typesense cannot exclude ids
  from a facet at query time, so where the identity’s target declares
  `facetKeys`, the admitted ids are still written to a top-level
  `${name}_facet`, as for any facetable reference.
- **A `local` lookup on a Root Type keeps its `${name}_id` companion.** That is
  a different shape: the companion is the only leaf holding the endpoints’ ids,
  not a second copy of one.

The GraphQL surface does not change: `where: { contributor: { in: […] } }` and
`facets { contributor }` keep their shape.

## Consequences

- Every deployment with an `identity` needs a full reindex. An existing
  collection lacks the faceted nested leaf, and the in-place rebuild refuses it
  with the instruction to drop the collection. Of the known deployments, only
  Linked Open Limburg declares an `identity`, and its identity field is already
  `filterable`.
- An `identity` naming an `array` field, previously accepted, is now refused.
  No known deployment declares one.
- A reference with an identity is stored once, and the projection harvests ids
  only where a facet policy needs them.
- The narrowed companion of an inline reference is renamed from
  `${name}_id_facet` to `${name}_facet`, since there is no `${name}_id` for it
  to narrow.
