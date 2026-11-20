# 38. Search a document by its referents’ labels

Date: 2026-11-16

## Status

Accepted

Amends [ADR 20](0020-resolve-a-references-fields-from-the-targets-own-collection.md)
for search: display still resolves from the target’s collection.

## Context

A reference stores its referents’ ids, and the API resolves their labels from
the target’s collection when a result is shown. Free text never reached those
labels. `searchable` on a reference folded the stored IRIs into
`${name}_search`, which no visitor types.

In Linked Open Limburg, 1291 works have `schema:about` pointing to the term
“boerenbont”, yet the query `boerenbont` finds 187
([limburg/lol#318](https://codeberg.org/limburg/lol/issues/318),
[lde#1058](https://github.com/ldelements/lde/issues/1058)).

## Decision

A `searchable` reference naming a label source (a `lookup`’s `target`, an
`idOnly`’s `labelSource`) is searched by its referents’ labels.

- **The extraction reads the label off the referent**, one hop from the root,
  in an `OPTIONAL` branch beside the key hop. It is the target’s label field,
  emitted under the target’s alias.
- **The projection folds those labels into `${name}_search`**, keeping only
  the label field’s declared `locales`. The companion keeps its name and type,
  so the collection definition and `query_by` are unchanged.
- **The label field must have a `path`.** `searchSchema` refuses a searchable
  reference whose label source derives its label, since the hop has nothing to
  read.
- A reference naming no label source still folds its IRIs.

## Consequences

- The label searched is the one the root’s own graph states for its referent.
  Tracé states `schema:name "Boerenbont"@nl` on its own term, which 1103 of the
  1291 works reference, so those carry the label. A referent stated by IRI alone, or whose label only
  an enrichment supplies, adds nothing, and a keyed referent is searched by the
  publisher’s label even where the API displays the Authority’s.
- A copied label changes only when the root is reindexed. A blue-green rebuild
  reindexes every root, so a stale label lasts until the next run.
- `local` lookups still refuse `searchable`.
- A `derive`d or `from` reference reads no referent off the graph, so it is
  never searched by labels and needs no label path.

## Alternatives considered

- **Query the target collection first, then filter roots on the matching ids.**
  It needs no copy, but it is two queries per search, it can’t rank a root by
  how well its referent matched, and the id list grows with the number of
  matching terms.
- **A Typesense join in `query_by`.** Typesense filters across a join but does
  not search joined fields.
