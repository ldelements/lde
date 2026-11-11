# 36. Facet a root document on its entries’ leaves

Date: 2026-11-10

## Status

Accepted

## Context

`searchSchema` refused `facetable` on a leaf of a Reference Type, because an
engine counts a nested field per document, not per entry
([ADR 24](0024-carry-data-on-a-reference-edge.md)). The one way to facet a
nested value was an `identity` companion, which needs a nested reference into
another collection.

For some leaves, the per-document count is exactly the question. Linked Open
Limburg’s licence facet asks which works have a reproduction under a given
licence: a work counts once per licence, whichever reproduction carries it.
`MediaObject.license` has no collection behind it, so LOL derived a flat
`license` field on the work. `where: { license }` and `facets { license }` then
named a field the response does not serve; the response serves
`associatedMedia[].license`.

## Decision

An inline reference on a Root Type may list leaves of its Reference Type in
`ref.facetedLeaves`. Each becomes a facet named `‹reference›.‹leaf›`.

- **A bucket counts root documents.** A work with three reproductions, two
  under CC BY, counts once under CC BY. Typesense flattens a leaf under an
  `object[]` into one list per document and counts it that way. A container
  test pins this against Typesense 30.2, also under a filter on the same leaf
  and under a weld on another leaf. The adapter facets the nested path
  directly, so a faceted leaf needs no companion.
- **Declared on the reference, not on the leaf.** The count is a fact about
  the root, and a Reference Type nested from several places may be faceted
  from one and not another. A reference type cannot declare them: it has no
  documents to count.
- **The leaf must be `filterable`, and so must the reference.** A bucket is
  selected by a condition on one entry, the filter [#1012](https://github.com/ldelements/lde/issues/1012) added: one condition
  on one leaf selects the same documents whether read per entry or per
  document. That also makes the leaf single-valued, since a weldable leaf may
  not be `array`. Only `keyword`, `boolean` and `reference` leaves key a
  bucket. Range bins and deeper paths wait until someone needs them.
- **The surface names the path.** GraphQL serves the facet as
  `facets { associatedMedia { license } }` and filters it through
  `where: { associatedMedia: { where: { license: … } } }`. A reference with an
  `identity` stays keyed by that identity (`facets { contributor }`); an
  entry’s other leaves are reached by their path.
- **A weld of several conditions is nobody’s own.** A clause belongs to a
  facet when it holds one condition on that facet’s leaf, through `on` or a
  weld of one condition. A weld of several constrains two parts of one entry,
  as a clause spanning two fields constrains two fields
  ([ADR 18](0018-filter-across-several-fields-with-one-clause.md)), so every
  facet counts under it. This settles [#952](https://github.com/ldelements/lde/issues/952) for `identity` facets as well.

## Consequences

- LOL drops its derived `license` field and its own reader over projected
  nested nodes, and reindexes.
- A lookup leaf whose target declares `facetKeys` is refused: the nested path
  holds every id, and no narrowed companion is written inside an entry yet.
- A reference cannot be both `facetable` and carry `facetedLeaves`, since both
  facets would be named after the reference.
- A weld of one condition on an `identity` leaf is on the axis
  `‹reference›.‹leaf›`, which no facet owns. An identity facet’s bucket is
  selected through the reference’s `in` arm, as GraphQL already sends it.
- The `identity` companion is the same flattened path stored twice; [#1045](https://github.com/ldelements/lde/issues/1045)
  drops it in favour of the nested path.
- A derived judgement over entries, such as LOL’s `hasMedia` (“some
  reproduction has a thumbnail”), stays a `derive`. Typesense has no native
  presence filter, so a generic one would be the same index-time boolean.
