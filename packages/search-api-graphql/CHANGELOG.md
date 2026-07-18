## 0.8.0 (2026-07-18)

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

### 🧱 Updated Dependencies

- Updated @lde/search to 0.9.0

## 0.7.1 (2026-07-18)

### 🧱 Updated Dependencies

- Updated @lde/search to 0.8.1

## 0.7.0 (2026-07-16)

### 🧱 Updated Dependencies

- Updated @lde/search to 0.8.0

## 0.6.1 (2026-07-16)

### 🧱 Updated Dependencies

- Updated @lde/search to 0.7.1

## 0.6.0 (2026-07-15)

### 🧱 Updated Dependencies

- Updated @lde/search to 0.7.0

## 0.5.0 (2026-07-13)

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

### 🧱 Updated Dependencies

- Updated @lde/search to 0.6.0

## 0.4.0 (2026-07-10)

### 🧱 Updated Dependencies

- Updated @lde/search to 0.5.0

## 0.3.1 (2026-07-10)

### 🧱 Updated Dependencies

- Updated @lde/search to 0.4.1

## 0.3.0 (2026-07-08)

### 🧱 Updated Dependencies

- Updated @lde/search to 0.4.0

## 0.2.1 (2026-07-08)

### 🧱 Updated Dependencies

- Updated @lde/search to 0.3.1

## 0.2.0 (2026-07-06)

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

### 🧱 Updated Dependencies

- Updated @lde/search to 0.3.0

## 0.1.0 (2026-07-05)

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

### 🧱 Updated Dependencies

- Updated @lde/search to 0.2.0