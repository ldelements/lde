# 41. Filter and facet a root document on whether an entry’s leaf has a value

Date: 2026-11-16

## Status

Accepted

Extends [ADR 40](0040-filter-and-facet-a-field-on-whether-it-has-a-value.md)
to a leaf of an inline reference.

## Context

ADR 40 lets a Root Type’s own field declare presence and refuses it on an
inline reference and on a Reference Type’s field. Linked Open Limburg still
derives `hasMedia`, “an `associatedMedia` entry has a `thumbnailUrl`”, beside
the reference it describes.

A boolean inside each entry does not answer that question. Typesense flattens
a leaf under an `object[]` into one list per document
([ADR 36](0036-facet-a-root-document-on-its-entries-leaves.md)), so a work
with one entry that has a thumbnail and one that lacks it would count in both
buckets, and a work with no entries in neither.

## Decision

An inline reference on a Root Type may list leaves of its Reference Type in
`ref.presenceLeaves`. For each, the root document is filtered and faceted on
whether any entry holds a value for the leaf.

- **One boolean per root document.** The projection writes
  `${reference}_${leaf}_exists`, true when any entry holds a value for the
  leaf in ADR 40’s sense and false otherwise, a document with no entries
  included. It reads the entries before pruning, so a leaf with no Role of its
  own still counts. `physicalFields(reference).leafExists` names it, and the reserved-name
  check covers it.
- **Declared on the reference**, as ADR 36 declares faceted leaves: the count
  is a fact about the root, and a Reference Type nested from several places
  may be counted from one and not another.
- **A weld of one condition selects it.**
  `{ field: 'associatedMedia', entry: [{ field: 'thumbnailUrl', exists: true }] }`
  compiles to the root’s boolean. `exists` welded to other conditions is
  refused (`exists-in-weld`): a root-level boolean cannot hold of the same
  entry as another condition. Through a join it stays refused, as in ADR 40.
- **The facet is `‹reference›.‹leaf›.exists`**, on the axis of the same name.
  It owns the one-condition weld on `exists`, never a weld on the leaf’s value,
  and a faceted leaf’s facet never owns it.
- **GraphQL nests it under the leaf.** The leaf’s key in `‹Edge›Where` takes
  `exists`, typed as an own field’s is (`ExistsFilter`, `‹Filter›OrExists`).
  Setting it beside another key of the same weld is an error naming the
  rewrite. The facet is served as `facets { associatedMedia { thumbnailUrl {
exists } } }`, inside the reference’s facet object.
- **One set of leaves per Reference Type.** `‹Edge›Where` is shared by every
  reference nesting that type, and its keys follow the presence leaves. So
  `searchSchema` requires every reference nesting one type to declare the same
  leaves, rather than emit a filter input per reference. Through a join, a
  reference with presence leaves takes `‹Edge›JoinedFilter`, without `exists`.

## Consequences

- LOL drops its derived `hasMedia`, as it drops `hasCoordinates` once
  [#1090](https://github.com/ldelements/lde/issues/1090) lands.
- The reference must be `filterable`, since a bucket is selected through a
  condition on one entry. A leaf is held to what an own field is: neither
  `text` nor `boolean`. A leaf that is itself an inline reference is refused,
  since an entry’s entries are not counted.
- Until [#1090](https://github.com/ldelements/lde/issues/1090) gives each
  field one facet object, a leaf cannot be both a faceted leaf and a presence
  leaf of one reference, and a `facetable` reference cannot declare presence
  leaves: both facets would claim one GraphQL key.
- A lookup reference may not declare presence leaves until #1090 brings a
  target’s values onto the root document.
- Two `filterable` references on Root Types nesting one Reference Type with
  different leaves are refused, until #1090’s per-reference filter inputs. A
  deployment that needs both before then declares a second Reference Type.
