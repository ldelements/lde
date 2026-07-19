## 0.10.0 (2026-07-19)

### 🚀 Features

- ⚠️  **search:** make path the whole statement of what projection reads ([#628](https://github.com/ldelements/lde/pull/628))

### ⚠️  Breaking Changes

- **search:** make path the whole statement of what projection reads  ([#628](https://github.com/ldelements/lde/pull/628))

## 0.9.0 (2026-07-18)

### 🚀 Features

- ⚠️  **search-pipeline:** project inside the batch, per root type (ADR 13) ([#627](https://github.com/ldelements/lde/pull/627))

### ⚠️  Breaking Changes

- **search-pipeline:** project inside the batch, per root type (ADR 13)  ([#627](https://github.com/ldelements/lde/pull/627))
  @lde/search no longer exports projectGraph or TypedSearchDocument, and
  buildSubjectIndex takes only the quad source (no rootTypes).
  * feat(search-pipeline)!: per-type projecting stages, retire the buffering writer
  Compose a search pipeline as one terminal and N per-type stages. searchStages
  builds one projecting Stage per root type: each selects its roots, extracts each
  root's quads, and projects the root-complete batch (projectRoots) into documents
  tagged with their SearchType, so memory is bounded by batchSize roots, not the
  dataset. selectByClass is a convenience selector for the object grain.
  searchIndexWriter becomes a Writer<TypedSearchDocument>: it keeps ADR 9's
  per-collection fan-out and run lifecycle but stops projecting and stops
  buffering, routing each tagged document straight to its type's engine run.
  TypedSearchDocument now lives here, the glue that needs it.
  BREAKING CHANGE: searchIndexWriter now consumes TypedSearchDocument, not Quad,
  and no longer projects; compose it with searchStages.
  * fix(search-pipeline): fail clearly when a selector omits the stage's rootVariable
  The batch project closure dereferenced binding[rootVariable].value directly, so a
  config mismatch (the stage's rootVariable differs from the selector's projected
  variable) threw an opaque TypeError. Guard the deref and throw a named error that
  points at the type and the unbound variable.
  * docs(search): fix the GraphQL indexing example and drop the tag metaphor
  The search-api-graphql README credited searchSchema with indexing (it only builds
  a schema, and the line was an unassigned no-op); clarify that the pipeline indexes
  the superset schema while the GraphQL API serves a subset. Reword the frameSubjects
  comment, which still referenced the removed rootType. Rename the document-SearchType
  relationship from tag to pair throughout (TypedSearchDocument is literally a pair);
  BCP-47 language-tag wording is left untouched."
  M	package-lock.json
  M	packages/search-api-graphql/README.md
  M	packages/search-pipeline/README.md
  M	packages/search-pipeline/package.json
  M	packages/search-pipeline/src/index.ts
  M	packages/search-pipeline/src/search-index-writer.ts
  A	packages/search-pipeline/src/search-stages.ts
  A	packages/search-pipeline/src/typed-search-document.ts
  M	packages/search-pipeline/test/multi-collection.integration.test.ts
  M	packages/search-pipeline/test/search-index-writer.test.ts
  A	packages/search-pipeline/test/search-stages.test.ts
  M	packages/search/README.md
  M	packages/search/package.json
  M	packages/search/src/engine.ts
  M	packages/search/src/frame-by-type.ts
  M	packages/search/src/index.ts
  M	packages/search/src/project.ts
  M	packages/search/test/frame-by-type.test.ts
  M	packages/search/test/project.test.ts
  M	packages/search/vite.config.ts

## 0.8.1 (2026-07-18)

### 🚀 Features

- **search:** add projectRoots, the roots-given projection primitive ([#625](https://github.com/ldelements/lde/pull/625))

## 0.8.0 (2026-07-16)

### 🚀 Features

- ⚠️  **search:** refuse to name a search type whose name cannot be spelled ([#605](https://github.com/ldelements/lde/pull/605))

### ⚠️  Breaking Changes

- **search:** refuse to name a search type whose name cannot be spelled  ([#605](https://github.com/ldelements/lde/pull/605))
  physicalNameTokens throws for a name it cannot spell, and for
  one leaving no word to name a container after, where it previously returned
  mangled tokens or an empty array. Adapters keep only their own engine's
  legality rules - the Typesense adapter still rules on the formatted result.
  - Drop the now-redundant top-level name from ResolvedRebuildOptions (internal),
    leaving definitionOptions.name as the one place the resolved name lives.
  - Fix the unclosed Blue/green Rebuild link in the search-typesense README."
  M	packages/search-typesense/README.md
  M	packages/search-typesense/src/blue-green-rebuild.ts
  M	packages/search-typesense/src/collection-name.ts
  M	packages/search-typesense/src/in-place-rebuild.ts
  M	packages/search-typesense/src/rebuild-support.ts
  M	packages/search-typesense/test/collection-name.test.ts
  M	packages/search-typesense/test/rebuild-support.test.ts
  M	packages/search-typesense/vite.config.ts
  M	packages/search/src/physical-name.ts
  M	packages/search/test/physical-name.test.ts
  M	packages/search/vite.config.ts

## 0.7.1 (2026-07-16)

### 🚀 Features

- **search-typesense:** derive collection names from the search type ([#604](https://github.com/ldelements/lde/pull/604))

## 0.7.0 (2026-07-15)

### 🚀 Features

- ⚠️  **search:** preserve all languages in text display ([#601](https://github.com/ldelements/lde/pull/601))

### ⚠️  Breaking Changes

- **search:** preserve all languages in text display  ([#601](https://github.com/ldelements/lde/pull/601))
  PhysicalFields no longer carries the enumerated display array;
  use displayFieldName/displayFieldPattern/displayLangOf. Label collections must
  be rebuilt to gain the regex display field.
  * fix(search): harden language-tag and field-name handling
  - Normalise an underscore-style language tag (pt_BR -> pt-BR) at projection, so
    a non-BCP-47 tag round-trips through the regex display field instead of being
    silently dropped on read.
  - Validate field names as metacharacter-free identifiers (the name is
    interpolated into the display RE2 pattern) and text locales as BCP-47-shaped
    (no underscore, the reserved name-locale separator).
  - Collapse the display projection to a single pass, and add a round-trip test
    binding displayFieldName/displayFieldPattern/displayLangOf so the convention
    cannot silently drift."
  A	docs/decisions/0010-preserve-all-languages-in-text-display.md
  M	packages/search-typesense/README.md
  M	packages/search-typesense/src/collection-definition.ts
  M	packages/search-typesense/src/search.ts
  M	packages/search-typesense/test/__snapshots__/generator-stability.test.ts.snap
  M	packages/search-typesense/test/collection-definition.test.ts
  M	packages/search-typesense/test/label-sources.test.ts
  M	packages/search-typesense/test/parse-response.test.ts
  M	packages/search-typesense/test/search-engine.test.ts
  M	packages/search-typesense/vite.config.ts
  M	packages/search/README.md
  M	packages/search/src/adapter.ts
  M	packages/search/src/project.ts
  M	packages/search/src/schema.ts
  M	packages/search/test/project.test.ts
  M	packages/search/test/schema.test.ts
  M	packages/search/vite.config.ts

## 0.6.0 (2026-07-13)

### 🚀 Features

- ⚠️  **search:** rename to de-overload “schema” in the search family ([#595](https://github.com/ldelements/lde/pull/595))

### ⚠️  Breaking Changes

- **search:** rename to de-overload “schema” in the search family  ([#595](https://github.com/ldelements/lde/pull/595))
  @lde/search SearchType.type is renamed to .class, and
  @lde/search-typesense buildCollectionSchema / CollectionSchemaOptions become
  buildCollectionDefinition / CollectionDefinitionOptions. @lde/search-pipeline
  and @lde/search-api-graphql adapt internally; their own public APIs are
  unchanged."
  M	docs/decisions/0003-search-api-core-query-model.md
  M	docs/decisions/0004-search-api-graphql-surface.md
  M	docs/decisions/0008-resolve-reference-labels-from-per-reference-label-sources.md
  M	docs/decisions/0009-route-a-whole-schema-projection-to-per-type-collections.md
  M	packages/search-api-graphql/test/build-schema.test.ts
  M	packages/search-api-graphql/test/facet-batch.test.ts
  M	packages/search-api-graphql/test/generator-stability.test.ts
  M	packages/search-pipeline/README.md
  M	packages/search-pipeline/src/search-index-writer.ts
  M	packages/search-pipeline/test/multi-collection.integration.test.ts
  M	packages/search-pipeline/test/search-index-writer.test.ts
  M	packages/search-typesense/README.md
  M	packages/search-typesense/src/blue-green-rebuild.ts
  R096	packages/search-typesense/src/collection-schema.ts	packages/search-typesense/src/collection-definition.ts
  M	packages/search-typesense/src/in-place-rebuild.ts
  M	packages/search-typesense/src/index.ts
  M	packages/search-typesense/src/rebuild-support.ts
  M	packages/search-typesense/src/search.ts
  M	packages/search-typesense/test/__snapshots__/generator-stability.test.ts.snap
  M	packages/search-typesense/test/blue-green-rebuild.test.ts
  R093	packages/search-typesense/test/collection-schema.test.ts	packages/search-typesense/test/collection-definition.test.ts
  M	packages/search-typesense/test/generator-stability.test.ts
  M	packages/search-typesense/test/in-place-rebuild.test.ts
  M	packages/search-typesense/test/label-sources.test.ts
  M	packages/search-typesense/test/parse-response.test.ts
  M	packages/search-typesense/test/query-compiler.test.ts
  M	packages/search-typesense/test/rebuild-error-paths.test.ts
  M	packages/search-typesense/test/rebuild-support.test.ts
  M	packages/search-typesense/test/search-engine.test.ts
  M	packages/search/README.md
  M	packages/search/src/project.ts
  M	packages/search/src/schema.ts
  M	packages/search/src/testing.ts
  M	packages/search/test/engine.test.ts
  M	packages/search/test/project.test.ts
  M	packages/search/test/query.test.ts
  M	packages/search/test/schema.test.ts

## 0.5.0 (2026-07-10)

### 🚀 Features

- ⚠️  **search:** route a whole-schema projection to per-type collections ([#592](https://github.com/ldelements/lde/pull/592))

### ⚠️  Breaking Changes

- **search:** route a whole-schema projection to per-type collections  ([#592](https://github.com/ldelements/lde/pull/592))
  projectGraph yields TypedSearchDocument, not SearchDocument. Read
  .document for the projected document.
  * feat(search-pipeline)!: route a whole-schema projection to per-type collections
  searchIndexWriter now fans one mixed projection stream out to the engine writer for
  each root type's collection, instead of streaming to a single writer. It takes a
  writerFor(searchType) factory, opens one engine run per type, and dispatches each
  projected document to the run for its type. A single-collection deployment is the N=1
  case; the pipeline never branches on the multi-collection shape.
  Each type is an independent blue/green rebuild (own collection, alias, lock), so the
  collections commit, sweep and fail in isolation: an empty projection for one type
  touches only its own collection; commit finalizes every collection independently and
  throws an AggregateError if any fails, so a label-collection failure never blocks the
  datasets index going live; abort finalizes only the collections that did not already
  go live (aborting a committed rebuild would drop its now-live collection).
  - add a Typesense-container integration test for independent swaps, one-type failure
    isolation, empty projection and abort cleanup
  - add ADR 9; update the READMEs
  BREAKING CHANGE: searchIndexWriter takes writerFor(searchType) instead of a single
  writer option.
  * fix(search-typesense): make BlueGreenRebuild.commit atomic at the alias swap
  The alias swap is the commit point: once it lands the new collection is live.
  The lock release that followed was unguarded, so a transient failure there
  rejected commit AFTER the swap. A caller that aborts on a rejected commit (the
  pipeline does) would then drop the collection the alias now points at, leaving
  the index pointed at a deleted collection.
  - swallow a post-swap lock-release failure (the lock is reclaimed on its TTL),
    matching the already-guarded superseded-collection delete
  - regression test: commit stays resolved when releasing the lock fails"
  M	README.md
  A	docs/decisions/0009-route-a-whole-schema-projection-to-per-type-collections.md
  M	package-lock.json
  M	packages/search-pipeline/README.md
  M	packages/search-pipeline/package.json
  M	packages/search-pipeline/src/search-index-writer.ts
  A	packages/search-pipeline/test/multi-collection.integration.test.ts
  M	packages/search-pipeline/test/search-index-writer.test.ts
  A	packages/search-pipeline/test/typesense-container.ts
  M	packages/search-pipeline/tsconfig.lib.json
  M	packages/search-pipeline/tsconfig.spec.json
  M	packages/search-typesense/src/blue-green-rebuild.ts
  M	packages/search-typesense/test/rebuild-error-paths.test.ts
  M	packages/search-typesense/vite.config.ts
  M	packages/search/README.md
  M	packages/search/src/index.ts
  M	packages/search/src/project.ts
  M	packages/search/test/project.test.ts

## 0.4.1 (2026-07-10)

### 🚀 Features

- **search:** accept Iterable<Quad> in projectGraph ([#580](https://github.com/ldelements/lde/pull/580))

## 0.4.0 (2026-07-08)

### 🚀 Features

- ⚠️  **search:** per-reference label sources ([#566](https://github.com/ldelements/lde/pull/566), [#568](https://github.com/ldelements/lde/issues/568))

### ⚠️  Breaking Changes

- **search:** per-reference label sources  ([#566](https://github.com/ldelements/lde/pull/566), [#568](https://github.com/ldelements/lde/issues/568))
  TypesenseSearchEngineOptions.labelsCollection is
  removed. Declare each label source as a SearchType (with an output,
  searchable text field ‘label’), add its collection to
  options.collections, set labelSource on each reference field, and
  rebuild label collections via buildCollectionSchema so the physical
  label fields exist. fetchLabels now takes label-lookup groups instead
  of (collection, iris).
  * refactor(search): single-source the label-field convention
  Review cleanups on the label sources:
  - labelFieldOf (exported via @lde/search/adapter) is the one place that
    knows what makes a type a label source; the schema validation and the
    Typesense engine both consult it instead of re-deriving the ‘label’
    convention per package.
  - labelValue reuses the existing localizedValue reconstruction and reads
    the untagged fallback from the label field’s own name instead of a
    literal.
  - The engine precomputes each type’s distinct label-source collections
    at construction and reuses the merged cached label map until any
    constituent collection reloads, instead of re-deduplicating and
    re-merging the full maps on every search.
  * fix(search): reject a labelSource declared on a non-reference field
  assertResolvableLabelSources validated labelSource only on reference fields, so
  a labelSource on a keyword or text field – reachable from a generated or
  hand-written schema, the untyped path this validator guards – passed searchSchema
  silently and then resolved nothing. Throw at startup so the misconfiguration
  fails fast instead of surfacing as unlabelled buckets in production.
  * fix(search-typesense): query all label locales and keep empty labels id-only
  Two per-reference label-resolution fixes found in review:
  - LabelSource.queryBy used only the first locale’s folded search field
    (physicalFields(labelField).search[0]); join all per-locale search fields so a
    label search matches every locale, not just the first.
  - a label document with no usable locale column and no bare label produced
    label: {}, which referenceValue treats as a present label; labelValue now
    returns undefined and the write skips it, so the reference stays id-only.
  * fix(search-typesense): isolate label-source failures and honor id-only references
  From the #566 review:
  - a single label collection erroring inline (e.g. mid-rebuild) made fetchLabels
    throw, blanking every reference on the page to id-only; report the failed
    source via onLabelError and skip only its entry, so healthy sources still
    resolve.
  - a reference or facet with no labelSource could still gain a label in cached
    mode, where the whole collection is preloaded into the shared map; skip the
    lookup for id-only fields and facets so they stay id-only by declaration.
  * perf(search-typesense): precompute label-lookup sources, skip non-source facets
  From the #566 review: labelLookupGroups re-derived the output reference fields
  and re-resolved their label sources on every search/searchFacets call, and
  probed `sources` per facet bucket. Precompute the { field, source } pairs once
  at construction, and skip a non-source facet in one check instead of per bucket.
  Behaviour-preserving; adds a facet test covering an id-only reference facet.
  * docs(search): renumber the label-sources ADR to 0008
  ADR 0007 is now taken by 0007-merge-namespace-alias-partitions on main (#568),
  so renumber the per-reference-label-sources ADR from 0007 to 0008 to avoid the
  collision when this branch merges.
  * docs(search): mark the label-sources ADR (0008) Accepted"
  M	docs/decisions/0005-batch-facet-queries-through-the-engine-port.md
  A	docs/decisions/0008-resolve-reference-labels-from-per-reference-label-sources.md
  M	packages/search-typesense/README.md
  M	packages/search-typesense/src/search.ts
  M	packages/search-typesense/test/fake-typesense-client.ts
  A	packages/search-typesense/test/label-sources.test.ts
  M	packages/search-typesense/test/parse-response.test.ts
  M	packages/search-typesense/test/search-engine.test.ts
  M	packages/search-typesense/vite.config.ts
  M	packages/search/README.md
  M	packages/search/src/adapter.ts
  M	packages/search/src/engine.ts
  M	packages/search/src/schema.ts
  M	packages/search/test/schema.test.ts
  M	packages/search/vite.config.ts

## 0.3.1 (2026-07-08)

This was a version bump only for @lde/search to align it with other projects, there were no code changes.

## 0.3.0 (2026-07-06)

### 🚀 Features

- ⚠️  **search:** batch facet searches into a single multi_search ([#554](https://github.com/ldelements/lde/pull/554))

### 🩹 Fixes

- **release:** unblock the search 0.3.0 release version bumps ([#557](https://github.com/ldelements/lde/pull/557))

### ⚠️  Breaking Changes

- **search:** batch facet searches into a single multi_search  ([#554](https://github.com/ldelements/lde/pull/554))
  SearchEngine implementations must add the searchFacets method.
  * feat(search)!: report per-query outcomes from searchFacets
  - searchFacets returns one FacetsOutcome ({ facets } or { error }) per query,
    so one failed query no longer discards its siblings' facets: the surface
    degrades exactly the failed query's facets and reports each via onFacetError
  - the Typesense adapter passes a failed multi_search entry through as an
    in-place error naming the query's facet fields, and normalizes orderBy
    away alongside limit/offset (facet-only compiles carry no sort)
  - fetchLabels now throws on an inline multi_search error entry, engaging the
    label degradation path instead of silently missing every label
  - a missing outcome (port-contract breach) is reported, not read as empty
  - restore the lazy iris thunk so the cached-label path skips collecting them
  - record the decision as ADR 5 and amend the port snippet in ADR 3
  BREAKING CHANGE: searchFacets returns FacetsOutcome[] instead of FacetMap[].
  * style: use EN dashes in prose added by the facet batching
  * test(search-typesense): extract a shared fake Typesense client
  - one configurable fake (search, export, multi_search; recorded performs and
    export calls) replaces the five bespoke fakes in parse-response.test.ts
  - labelLookup() shares the filter_by id-list answering between the fetchLabels
    and bundled-label-lookup tests
  - re-anchor coverage thresholds: the helper's defensive guards are uncovered"
  M	docs/decisions/0003-search-api-core-query-model.md
  A	docs/decisions/0005-batch-facet-queries-through-the-engine-port.md
  M	package-lock.json
  M	packages/search-api-graphql/README.md
  M	packages/search-api-graphql/package.json
  M	packages/search-api-graphql/src/build-schema.ts
  A	packages/search-api-graphql/src/facet-batch.ts
  M	packages/search-api-graphql/test/build-schema.test.ts
  A	packages/search-api-graphql/test/facet-batch.test.ts
  M	packages/search-api-graphql/vite.config.ts
  M	packages/search-typesense/README.md
  M	packages/search-typesense/src/search.ts
  A	packages/search-typesense/test/fake-typesense-client.ts
  M	packages/search-typesense/test/parse-response.test.ts
  M	packages/search-typesense/test/search-engine.test.ts
  M	packages/search-typesense/vite.config.ts
  M	packages/search/README.md
  M	packages/search/src/engine.ts
  M	packages/search/src/index.ts
  M	packages/search/src/testing.ts
  M	packages/search/test/engine.test.ts

## 0.2.0 (2026-07-05)

### 🚀 Features

- ⚠️  **search:** engine- and domain-agnostic query model, Typesense adapter, and GraphQL surface ([#529](https://github.com/ldelements/lde/pull/529))

### 🩹 Fixes

- **release:** unblock the search release version bumps ([#551](https://github.com/ldelements/lde/pull/551))

### ⚠️  Breaking Changes

- **search:** engine- and domain-agnostic query model, Typesense adapter, and GraphQL surface  ([#529](https://github.com/ldelements/lde/pull/529))
  reworks the @lde/search and @lde/search-typesense public APIs; see
  the package READMEs and ADRs 0003/0004.
  Claude-Session: https://claude.ai/code/session_01PDZBfA1bj35oc7Yqn1pc2n"
  M	README.md
  M	docs/decisions/0003-search-api-core-query-model.md
  M	docs/decisions/0004-search-api-graphql-surface.md
  M	package-lock.json
  A	packages/search-api-graphql/README.md
  A	packages/search-api-graphql/eslint.config.mjs
  A	packages/search-api-graphql/package.json
  A	packages/search-api-graphql/src/build-schema.ts
  A	packages/search-api-graphql/src/index.ts
  A	packages/search-api-graphql/src/language.ts
  A	packages/search-api-graphql/test/__snapshots__/generator-stability.test.ts.snap
  A	packages/search-api-graphql/test/build-schema.test.ts
  A	packages/search-api-graphql/test/generator-stability.test.ts
  A	packages/search-api-graphql/tsconfig.json
  A	packages/search-api-graphql/tsconfig.lib.json
  A	packages/search-api-graphql/tsconfig.spec.json
  A	packages/search-api-graphql/vite.config.ts
  M	packages/search-typesense/README.md
  M	packages/search-typesense/package.json
  M	packages/search-typesense/src/adapter.ts
  A	packages/search-typesense/src/collection-schema.ts
  M	packages/search-typesense/src/index.ts
  A	packages/search-typesense/src/query-compiler.ts
  A	packages/search-typesense/src/search.ts
  A	packages/search-typesense/test/__snapshots__/generator-stability.test.ts.snap
  M	packages/search-typesense/test/adapter.test.ts
  A	packages/search-typesense/test/collection-schema.test.ts
  A	packages/search-typesense/test/generator-stability.test.ts
  A	packages/search-typesense/test/parse-response.test.ts
  A	packages/search-typesense/test/query-compiler.test.ts
  A	packages/search-typesense/test/search-engine.test.ts
  M	packages/search-typesense/tsconfig.lib.json
  M	packages/search-typesense/vite.config.ts
  M	packages/search/README.md
  M	packages/search/package.json
  A	packages/search/src/adapter.ts
  A	packages/search/src/engine.ts
  M	packages/search/src/index.ts
  M	packages/search/src/project.ts
  A	packages/search/src/query.ts
  A	packages/search/src/schema.ts
  A	packages/search/src/testing.ts
  A	packages/search/test/engine.test.ts
  M	packages/search/test/project.test.ts
  A	packages/search/test/query.test.ts
  A	packages/search/test/schema.test.ts
  M	packages/search/vite.config.ts
  M	tsconfig.json

## 0.1.2 (2026-06-26)

### 🧱 Updated Dependencies

- Updated @lde/text-normalization to 0.1.1

## 0.1.1 (2026-06-19)

### 🩹 Fixes

- **search:** frame the root subject, not the first graph node ([#503](https://github.com/ldelements/lde/pull/503))

## 0.1.0 (2026-06-18)

### 🚀 Features

- **search:** pin @lde/text-normalization to an exact version ([#496](https://github.com/ldelements/lde/pull/496))
- add @lde/search-typesense and @lde/text-normalization ([#475](https://github.com/ldelements/lde/pull/475), [#252](https://github.com/ldelements/lde/issues/252))

### 🧱 Updated Dependencies

- Updated @lde/text-normalization to 0.1.0