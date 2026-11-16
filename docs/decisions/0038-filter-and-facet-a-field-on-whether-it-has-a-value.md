# 38. Filter and facet a field on whether it has a value

Date: 2026-11-16

## Status

Accepted

Supersedes the last consequence of
[ADR 36](0036-facet-a-root-document-on-its-entries-leaves.md) for a Root
Type’s own field.

## Context

Typesense has no presence filter, so a deployment that needs “only works with
a creation date” declares a boolean of its own: a `derive` beside the field it
describes. Linked Open Limburg has two such fields, `hasMedia` and
`hasCoordinates`, and a third, `hasDateCreated`, is requested. Each is a
second name for a question about the first, which a client has to learn and a
deployment has to keep in step with the field it reads.

ADR 36 left such a judgement a `derive`, since a generic presence filter would
be the same index-time boolean. That is the argument for writing that boolean
once, in LDE, rather than once per field per deployment.

## Decision

A field may declare `presence: true`. It is then filtered by an `exists`
criterion, `{ field: 'dateCreated', exists: true }`, and faceted as
`dateCreated.exists`, with one bucket for documents that hold a value and one
for documents that hold none.

- **A document holds a value when its projected field does**: a non-empty
  list or a defined scalar, which is what the response serves. A value the
  field’s reader cannot read is reported and left out
  ([ADR 33](0033-report-the-values-a-typed-field-could-not-read.md)): a
  `period` stated as `onbekend` is neither stored nor served. A document whose only value is unreadable
  therefore holds none. An empty list counts as no value too: it is what a
  derived `array` reference stores when its derive yields no IRI.
- **A boolean companion on every document.** The projection writes
  `${name}_exists` once the whole root document is projected, so a presence
  reads what a later `derive` left too. It writes `false` as well as `true`:
  without the `false`, the facet’s second bucket and `exists: false` would
  have nothing to read. `physicalFields` names it, beside the field’s other
  companions, so the projection, the collection definition and the compiler
  read one name. Typesense declares it `bool`, indexed and `facet: true`, and
  not optional. An In-place rebuild over a collection that predates it fails
  at open, as it does for every other facet companion.
- **Not a Role.** What a query reads is the companion, never the value, so a
  field declaring presence alone stays an internal field: projected, read
  for its companion, then pruned, its value stored nowhere and indexed by
  nothing. It still takes `exists` without being `filterable`; being
  `filterable` is what lets it take its kind’s own operator beside `exists`.
  The refusals below are `validateSearchType` issues, so a declaration
  checked outside TypeScript meets them too.
- **One axis per question.** `exists` on a field is on the axis
  `‹field›.exists`, which the presence facet owns. It owns no `range` or `in`
  on the same field, and a facet on the field’s values owns no `exists`: “has
  a date” and “dated after 1900” are different questions, so each facet
  counts under the other’s clause.
- **`FacetDeclaration.presence` marks the facet.** Its buckets are booleans
  whatever the field’s kind, carry `is` like a `boolean` facet’s, and are
  selected through `exists` (`selectionOf`). Nothing that reads a facet’s
  field for labels or bins applies to it.
- **GraphQL asks the field itself.** The field’s `where` input gains an
  `exists` arm: `‹Filter›OrExists` (`DateRangeOrExists`) for a field that is
  also `filterable`, `ExistsFilter` for one that is not. Setting `exists`
  beside another key of the same input is an error naming the rewrite. The
  facet is served under the field, `facets { dateCreated { exists { value
count } } }`, as `‹Type›‹Field›Facets`, the per-field grouping ADR 36 gave a
  reference’s leaves.

## Consequences

- LOL can drop `hasDateCreated` before it is written, and `hasMedia` and
  `hasCoordinates` once presence reaches the leaves they read.
- Only a Root Type’s own field declares presence for now. `searchSchema`
  refuses it on:
  - a field of a Reference Type and an inline reference: presence on an
    entry’s leaf, counted per root document as ADR 36’s faceted leaves are,
    is [#1091](https://github.com/ldelements/lde/issues/1091)’s second part;
  - a field that is already `facetable`: its facet would have to become an
    object to hold both kinds of bucket, the shape change
    [#1090](https://github.com/ldelements/lde/issues/1090) makes once for
    both;
  - a `text` field, which stores its values per language, so no one stored
    value says whether it has one; declare presence on a `keyword` over the
    same path;
  - a `boolean`, which states its own absence as `false`.
- `exists` is refused through a join path (`joined-presence`): the joined
  type’s companion exists, but no join reads it yet. GraphQL therefore reaches
  a type declaring presence through a join by `‹Type›JoinedWhere`, which
  offers no `exists`. Inside a weld `exists` meets `no-presence`, since no
  Reference Type field declares presence.
- A reference that declares presence takes `‹Target›FilterOrExists`, not the
  `‹Target›Filter` its target’s `id` takes, so the refined discovery strategy
  no longer reaches it. The coarse one does, since its `in` is still `IRI`.
- Each presence field costs one indexed boolean per document.
