## 0.12.2 (2026-07-24)

### 🚀 Features

- **search-pipeline:** add searchIndexerPipeline convenience ([#647](https://github.com/ldelements/lde/pull/647))

### 🧱 Updated Dependencies

- Updated @lde/search-typesense to 0.15.2
- Updated @lde/pipeline to 0.35.1

## 0.12.1 (2026-07-23)

### 🩹 Fixes

- **search-pipeline:** exclude blank-node subjects from selectByClass ([ee2ca3c](https://github.com/ldelements/lde/commit/ee2ca3c))

### 🧱 Updated Dependencies

- Updated @lde/search-typesense to 0.15.1
- Updated @lde/search to 0.12.1

## 0.12.0 (2026-07-23)

### 🧱 Updated Dependencies

- Updated @lde/search-typesense to 0.15.0
- Updated @lde/pipeline to 0.35.0

## 0.11.2 (2026-07-23)

### 🧱 Updated Dependencies

- Updated @lde/search-typesense to 0.14.2
- Updated @lde/pipeline to 0.34.4

## 0.11.1 (2026-07-23)

### 🧱 Updated Dependencies

- Updated @lde/search-typesense to 0.14.1
- Updated @lde/pipeline to 0.34.3

## 0.11.0 (2026-07-22)

### 🚀 Features

- ⚠️  **search:** generate extraction CONSTRUCTs from the search schema ([#630](https://github.com/ldelements/lde/pull/630))

### ⚠️  Breaking Changes

- **search:** generate extraction CONSTRUCTs from the search schema  ([#630](https://github.com/ldelements/lde/pull/630))
  the projection now reads each value under its field’s IR
  alias, not its source path; a reader must emit values under irAlias(type,
  field). path no longer keys the framed node.
  * feat(search-pipeline)!: generate extraction CONSTRUCTs from the search schema
  - Add extractionQuery / extractionQueryString: a pure SearchType →
    QueryConstruct generator (Traqula AstFactory) that mints one IR-Alias
    template triple per path-bearing field, a UNION branch per field reading its
    source path as a SPARQL property path, a free subject for the pipeline’s
    VALUES injection, and a nested template for inline references (recursing to
    the schema’s declared depth).
  - Default a stage’s reader to this generated Extraction CONSTRUCT: readers on
    SearchStageType is now optional, so a SPARQL deployment need not hand-write
    the query, and reader and projection agree by construction on the alias set.
  - Add a schema↔CONSTRUCT contract test (the minted alias set equals the field
    set the projection reads) and an end-to-end round-trip against a local SPARQL
    endpoint (generate → read → frame → project).
  - Drop the stale sparqljs entry from AGENTS.md Key Dependencies and register
    the round-trip endpoint port.
  BREAKING CHANGE: SearchStageType.readers is now optional and defaults to the
  generated Extraction CONSTRUCT; a stage relying on the default must declare its
  fields’ source paths in SPARQL property-path grammar.
  * docs(search-pipeline): explain extraction queries are well-formed for non-deduplicating engines
  - Document that the generated extraction CONSTRUCTs (UNION-per-field, given
    roots, single-subject template, no projected-away constant triple) emit one
    triple per genuine solution on a non-deduplicating engine such as QLever, so
    there is no multiplicative CONSTRUCT inflation.
  - Note that this removes the need for a client-side post-processing dedup pass,
    which would defeat the batch-bounded streaming memory model; the residual
    linear duplication from duplicate input roots is absorbed by the streaming
    per-quad subject index as a cheap backstop."
  M	AGENTS.md
  M	packages/search-pipeline/README.md
  M	packages/search-pipeline/package.json
  A	packages/search-pipeline/src/extraction.ts
  M	packages/search-pipeline/src/index.ts
  M	packages/search-pipeline/src/search-stages.ts
  A	packages/search-pipeline/test/extraction-roundtrip.integration.test.ts
  A	packages/search-pipeline/test/extraction.test.ts
  A	packages/search-pipeline/test/fixtures/drapo-sample.ttl
  M	packages/search-pipeline/test/multi-collection.integration.test.ts
  M	packages/search-pipeline/test/search-stages.test.ts
  M	packages/search-pipeline/tsconfig.lib.json
  M	packages/search/src/adapter.ts
  M	packages/search/src/project.ts
  M	packages/search/src/schema.ts
  M	packages/search/test/project.test.ts
  M	packages/search/test/schema.test.ts

### 🧱 Updated Dependencies

- Updated @lde/search-typesense to 0.14.0
- Updated @lde/search to 0.12.0

## 0.10.0 (2026-07-21)

### 🚀 Features

- ⚠️  **search:** implement inline references and class-less reference types ([#629](https://github.com/ldelements/lde/pull/629))

### ⚠️  Breaking Changes

- **search:** implement inline references and class-less reference types  ([#629](https://github.com/ldelements/lde/pull/629))
  class is now optional on SearchType (a reference type declares
  none); an inline ref.typeName is resolved and cycle-checked at searchSchema
  construction.
  * feat(search): prune internal fields recursively through surfaced inline referents
  - Prune internal (no-role) fields at every depth: a surfaced (output)
    inline reference now has its referent's internal helper fields removed
    before the writer, so the "a field without a role reaches neither the
    engine nor the API" invariant holds inside nested documents, not just
    at the root.
  - Pruning runs as one post-order pass after all projection, so a derive
    at any depth still reads a helper field before it is removed.
  - Mark ADR 11 Accepted."
  M	docs/decisions/0011-decouple-rdf-depth-from-the-api-surface.md
  M	packages/search-api-graphql/src/build-schema.ts
  M	packages/search-api-graphql/src/facet-batch.ts
  M	packages/search-api-graphql/test/build-schema.test.ts
  M	packages/search-pipeline/src/search-index-writer.ts
  M	packages/search-pipeline/src/search-stages.ts
  M	packages/search-pipeline/src/typed-search-document.ts
  M	packages/search-pipeline/test/multi-collection.integration.test.ts
  M	packages/search-pipeline/test/search-index-writer.test.ts
  M	packages/search-pipeline/test/search-stages.test.ts
  M	packages/search-typesense/src/search.ts
  M	packages/search-typesense/test/collection-name.test.ts
  M	packages/search/README.md
  M	packages/search/src/adapter.ts
  M	packages/search/src/engine.ts
  M	packages/search/src/frame-by-type.ts
  M	packages/search/src/index.ts
  M	packages/search/src/project.ts
  M	packages/search/src/schema.ts
  M	packages/search/src/testing.ts
  M	packages/search/test/frame-by-type.test.ts
  M	packages/search/test/project.test.ts
  M	packages/search/test/schema.test.ts
  M	packages/search/vite.config.ts

### 🧱 Updated Dependencies

- Updated @lde/search-typesense to 0.13.0
- Updated @lde/search to 0.11.0

## 0.9.0 (2026-07-19)

### 🚀 Features

- ⚠️  **search:** make path the whole statement of what projection reads ([#628](https://github.com/ldelements/lde/pull/628))

### ⚠️  Breaking Changes

- **search:** make path the whole statement of what projection reads  ([#628](https://github.com/ldelements/lde/pull/628))

### 🧱 Updated Dependencies

- Updated @lde/search-typesense to 0.12.0
- Updated @lde/search to 0.10.0

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

- Updated @lde/search-typesense to 0.11.0
- Updated @lde/search to 0.9.0

## 0.7.2 (2026-07-18)

### 🧱 Updated Dependencies

- Updated @lde/search-typesense to 0.10.2
- Updated @lde/search to 0.8.1

## 0.7.1 (2026-07-17)

### 🧱 Updated Dependencies

- Updated @lde/search-typesense to 0.10.1
- Updated @lde/pipeline to 0.34.2

## 0.7.0 (2026-07-16)

### 🧱 Updated Dependencies

- Updated @lde/search-typesense to 0.10.0
- Updated @lde/search to 0.8.0

## 0.6.1 (2026-07-16)

### 🚀 Features

- **search-typesense:** derive collection names from the search type ([#604](https://github.com/ldelements/lde/pull/604))

### 🧱 Updated Dependencies

- Updated @lde/search-typesense to 0.9.1
- Updated @lde/search to 0.7.1

## 0.6.0 (2026-07-15)

### 🧱 Updated Dependencies

- Updated @lde/search-typesense to 0.9.0
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

- Updated @lde/search-typesense to 0.8.0
- Updated @lde/search to 0.6.0

## 0.4.1 (2026-07-12)

### 🧱 Updated Dependencies

- Updated @lde/search-typesense to 0.7.1
- Updated @lde/pipeline to 0.34.1

## 0.4.0 (2026-07-10)

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

### 🧱 Updated Dependencies

- Updated @lde/search-typesense to 0.7.0
- Updated @lde/search to 0.5.0

## 0.3.1 (2026-07-10)

### 🧱 Updated Dependencies

- Updated @lde/search to 0.4.1

## 0.3.0 (2026-07-09)

### 🧱 Updated Dependencies

- Updated @lde/pipeline to 0.34.0

## 0.2.0 (2026-07-08)

### 🧱 Updated Dependencies

- Updated @lde/search to 0.4.0

## 0.1.2 (2026-07-08)

### 🧱 Updated Dependencies

- Updated @lde/pipeline to 0.33.4

## 0.1.1 (2026-07-08)

### 🚀 Features

- **search-pipeline:** compose search indexing as a pipeline instance ([#565](https://github.com/ldelements/lde/pull/565))

### 🧱 Updated Dependencies

- Updated @lde/pipeline to 0.33.3
- Updated @lde/search to 0.3.1