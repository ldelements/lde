# 8. Resolve reference labels from per-reference label sources

Date: 2026-07-06

## Status

Accepted

Amends the reference model of
[ADR 3 (Search API core query model)](./0003-search-api-core-query-model.md);
part of search as a Configurable Pipeline instance
([#534](https://github.com/ldelements/lde/issues/534)).

## Context

Reference labels resolved from one global sidecar `labels` collection,
configured engine-side (`labelsCollection`). With typed entity collections
(persons, organizations, terms) becoming first-class searchable collections,
every referenced entity lives in some typed collection already – a separate
IRI→label sidecar duplicates data that the typed collection carries, and the
engine option cannot say _which_ collection resolves _which_ reference. The
planned facet-by-name typeahead needs exactly that: a per-reference target
collection to search by label.

## Decision

- A reference declares its label source **in the schema**:
  `ReferenceField.labelSource` names the `SearchType` whose collection
  resolves the reference’s labels. The declaration stays engine-agnostic –
  the engine maps type → collection via its existing `collections` option, so
  a label source is just another entry there. One declaration drives
  projection, resolution and (later) typeahead.
- The named type must declare an `output`, `searchable` text field called
  `label`: something to reconstruct a label from, and something to type
  ahead against. `searchSchema` validates this schema-wide, so a dangling or
  unsuitable label source fails at startup, not per query.
- A reference without a `labelSource` is id-only: its IRIs never travel in a
  label lookup.
- **The global labels collection is dropped, not kept as a fallback for
  typeless referents** (resolving open decision 1 of #534): every reference
  that wants labels names a typed source. One model, no second path.
- The Typesense engine bundles all sources’ lookups into the single
  `multi_search` it already used, and the opt-in in-memory cache
  (`labelCacheTtlMs`) now caches per source collection. Labels reconstruct
  from the source type’s `label` declaration (its per-locale display
  fields), with a bare untagged `label` value as the `und` fallback.

## Consequences

- Breaking for `@lde/search-typesense` consumers: `labelsCollection` is gone.
  The Dataset Register declares its labels data as a `SearchType` (e.g. per
  entity kind), adds its collection(s) to `collections`, and sets
  `labelSource` on each reference field. Label collections are rebuilt via
  `buildCollectionDefinition` so the physical label fields exist.
- Reference facet buckets are labelled from the facet field’s own source,
  exactly as hit references are.
- The facet-by-name typeahead (issue #534, with #533’s value-query IR) gets
  its target for free: the reference’s `labelSource` names the collection to
  search by label.
