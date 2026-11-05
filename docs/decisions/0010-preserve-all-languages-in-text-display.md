# 10. Preserve all languages in text display

Date: 2026-07-13

## Status

Accepted

Amends the field model of
[ADR 3 (Search API core query model)](./0003-search-api-core-query-model.md)
and the label resolution of
[ADR 8 (Resolve reference labels from per-reference label sources)](./0008-resolve-reference-labels-from-per-reference-label-sources.md).
Resolves [#591](https://github.com/ldelements/lde/issues/591), a sub-issue of
[#534](https://github.com/ldelements/lde/issues/534).

## Context

A `text` field declared one `locales` list (e.g. `['nl', 'en']`) that drove
**both** the indexed per-locale search/sort fields **and** the display fields,
and projection emitted only those declared locales. A label in a language
outside the list (`foaf:name "Bibliothèque"@fr`), or an untagged one when `und`
was not declared, was silently dropped – so a facet bucket or reference rendered
as a bare IRI.

This bit the Dataset Register once its facet/reference labels moved onto the
ADR-8 `labelSource` model: the `Organization`, `Class` and `TerminologySource`
label sources declare `label` with `locales: ['nl', 'en']`, so any French,
German or untagged label fell outside the set and disappeared. A deployment
could add every language to `locales`, but that provisions a stemmed, indexed,
RAM-resident search field per language – for a need that is purely display – and
it cannot express an open language set (a thesaurus carries labels in tens of
languages a deployment cannot enumerate ahead of time).

The label sources are resolved **by IRI for display** (the engine looks them up
with `filter_by: id:[…]`, or dumps the collection; it never text-searches them),
so the missing-language problem is a display problem. And display fields are
already stored `index: false` – on disk, off RAM, unstemmed. Every reason the
flat per-locale model exists (per-locale stemming, query weighting, sort keys,
the RAM lever) is search-side; none applies to display.

## Decision

- **Decouple the display axis from the search/sort axis.** `locales` governs
  only the indexed fanout: the folded `${name}_search_${locale}` and
  `${name}_sort_${locale}` fields, unchanged. Display is no longer bound to it.
- **Display preserves every language present, by default.** Projection writes a
  display value for each language the data carries (`${name}_${lang}`, untagged
  under `und`), not only the declared locales. Because a language subtag never
  contains `_` but the `search_`/`sort_` infixes do, `${name}_${lang}` with
  `lang` matching `[^_]+` is an unambiguous display field. One convention – a
  writer (`displayFieldName`), a collection pattern (`displayFieldPattern`) and a
  reader (`displayLangOf`) – is the single source shared by projection, the
  Typesense collection definition and result reconstruction.
- **The engine stores display as one un-indexed regex field.** The Typesense
  collection declares `{ name: "${name}_[^_]+", type: "string", index: false,
optional: true }`, so any present language’s value is stored on disk and
  returned on a hit at no RAM cost; the explicit `${name}_search_${locale}`
  fields keep their own stemming (the regex excludes underscore suffixes, so
  there is no overlap). Resolution reconstructs the full language map by reading
  every present `${name}_<lang>` key, and the GraphQL surface already orders a
  language map best-first per `Accept-Language`, with any language outside the
  request as a fallback.
- **A deployment bounds the displayed languages upstream**, by selecting a
  language subset in its CONSTRUCT query – preservation is the default, narrowing
  is opt-out and lives with the deployment that knows which languages it wants.

## Consequences

- Breaking for `@lde/search` adapter consumers: `PhysicalFields` no longer
  carries an enumerated `display` array (display is pattern-based); the new
  `displayFieldName` / `displayFieldPattern` / `displayLangOf` helpers replace
  it. The label-reconstruction `und` fallback on a bare `label` field is gone –
  no `@lde`-built collection stores a bare `label`; untagged values live under
  `${name}_und`.
- Label collections must be rebuilt (blue/green) to gain the regex display
  field; the Dataset Register rebuilds every indexing run, so its `@fr`/untagged
  labels start rendering with no code change on its side.
- Search behaviour is unchanged: a language outside `locales` is displayed but
  not matched or sorted on. Per-language typeahead ([#533](https://github.com/ldelements/lde/issues/533))
  still declares the languages it wants searched via `locales`.
