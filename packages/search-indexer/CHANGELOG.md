## 0.10.1 (2026-08-20)

### 🧱 Updated Dependencies

- Updated @lde/search-typesense to 0.25.1
- Updated @lde/search-pipeline to 0.22.1
- Updated @lde/search to 0.22.1

## 0.10.0 (2026-08-17)

### 🧱 Updated Dependencies

- Updated @lde/search-typesense to 0.25.0
- Updated @lde/search-pipeline to 0.22.0
- Updated @lde/search to 0.22.0

## 0.9.1 (2026-08-14)

### 🧱 Updated Dependencies

- Updated @lde/search-typesense to 0.24.1
- Updated @lde/search-pipeline to 0.21.1
- Updated @lde/search to 0.21.1

## 0.9.0 (2026-08-14)

### 🧱 Updated Dependencies

- Updated @lde/search-typesense to 0.24.0
- Updated @lde/search-pipeline to 0.21.0
- Updated @lde/search to 0.21.0

## 0.8.0 (2026-08-14)

### 🚀 Features

- ⚠️  **search:** filter across collections through declared joins ([#719](https://github.com/ldelements/lde/pull/719))

### ⚠️  Breaking Changes

- **search:** filter across collections through declared joins  ([#719](https://github.com/ldelements/lde/pull/719))
  the Typesense rebuild and collection-definition options
  take `collectionNameFor: (searchType) => string` instead of `name: string`.
  Pass `collectionNameFor: () => 'x'` where a single name was passed before.
  * fix(search): close four gaps the review found in the join implementation
  - never abort a member of a partly-committed join component: the half-built
    collection it would drop is what the member that DID commit references by
    concrete name, so dropping it broke every join through the live index
    permanently. An orphaned collection is the lesser evil
  - reject `joinable` on an inline reference: the collection definition emitted
    the nesting and silently dropped the reference, so the join validated,
    compiled and only then failed at the engine
  - reject a `collectionNameFor` that gives a join target this type's own
    collection – the trap in migrating a constant from the old `name` option,
    which made the reference point the collection at itself
  - name the empty joined `where` inside an `or` on its own terms; it crashed on
    the missing clause instead of reporting anything
  * fix(pipeline): let a coordinating caller end a run without discarding its output
  - add the optional `RunWriter.abandon(error)`: finalize and release run-level
    resources, keep what was built. It falls back to `abort`, which is already
    right for a writer whose abort discards nothing
  - implement it on the Typesense blue/green rebuild as a lock release without
    the collection drop, and use it for the uncommitted peers of a committed
    member. Skipping them instead held the rebuild lock for its whole TTL and
    failed the next run outright
  - count `joinable` as a Role, so a join-only reference is stored rather than
    pruned as an Internal Field and then joined against a column that is not there
  - tell a lookalike search type apart from a missing schema when a joinable
    reference cannot be resolved
  * fix(search-api-graphql): key a join's `in` arm on IRI like every other identity filter
  - the arm asks what `‹Target›Filter` asks – which of the target's ids the
    field holds – so it must accept the same `[IRI!]` variable a consumer
    declares. Typing it `String` left the join the one place identity was not
    IRI-keyed"
  M	AGENTS.md
  A	docs/decisions/0019-filter-across-collections-through-declared-joins.md
  M	docs/reference/pipeline.md
  M	docs/reference/search-api-graphql.md
  M	docs/reference/search-pipeline.md
  M	docs/reference/search-typesense.md
  M	docs/reference/search.md
  M	packages/pipeline/src/writer/writer.ts
  M	packages/search-api-graphql/src/build-schema.ts
  M	packages/search-api-graphql/src/facet-batch.ts
  M	packages/search-api-graphql/test/facet-batch.test.ts
  A	packages/search-api-graphql/test/joins.test.ts
  M	packages/search-api-graphql/vite.config.ts
  M	packages/search-indexer/src/composition.ts
  M	packages/search-pipeline/src/search-index-writer.ts
  A	packages/search-pipeline/test/fixtures/joins-sample.ttl
  A	packages/search-pipeline/test/joins.integration.test.ts
  M	packages/search-pipeline/test/multi-collection.integration.test.ts
  M	packages/search-pipeline/test/search-index-writer.test.ts
  M	packages/search-typesense/src/blue-green-rebuild.ts
  M	packages/search-typesense/src/collection-definition.ts
  M	packages/search-typesense/src/in-place-rebuild.ts
  M	packages/search-typesense/src/index.ts
  M	packages/search-typesense/src/lock.ts
  M	packages/search-typesense/src/query-compiler.ts
  M	packages/search-typesense/src/rebuild-support.ts
  M	packages/search-typesense/src/search.ts
  M	packages/search-typesense/test/blue-green-rebuild.test.ts
  M	packages/search-typesense/test/collection-definition.test.ts
  M	packages/search-typesense/test/collection-name.test.ts
  M	packages/search-typesense/test/generator-stability.test.ts
  M	packages/search-typesense/test/in-place-rebuild.test.ts
  A	packages/search-typesense/test/joins.test.ts
  M	packages/search-typesense/test/rebuild-error-paths.test.ts
  M	packages/search-typesense/test/rebuild-support.test.ts
  A	packages/search-typesense/test/reference-backfill.integration.test.ts
  M	packages/search-typesense/test/search-engine.test.ts
  M	packages/search-typesense/vite.config.ts
  M	packages/search/src/adapter.ts
  M	packages/search/src/index.ts
  A	packages/search/src/join-graph.ts
  M	packages/search/src/query.ts
  M	packages/search/src/schema.ts
  A	packages/search/test/join-graph.test.ts
  M	packages/search/test/query.test.ts
  M	packages/search/test/schema.test.ts
  M	packages/search/vite.config.ts

### 🧱 Updated Dependencies

- Updated @lde/pipeline-console-reporter to 0.27.0
- Updated @lde/search-typesense to 0.23.0
- Updated @lde/search-pipeline to 0.20.0
- Updated @lde/pipeline to 0.36.0
- Updated @lde/search to 0.20.0

## 0.7.0 (2026-08-14)

### 🧱 Updated Dependencies

- Updated @lde/search-typesense to 0.22.0
- Updated @lde/search-pipeline to 0.19.0
- Updated @lde/search to 0.19.0

## 0.6.4 (2026-08-14)

### 🧱 Updated Dependencies

- Updated @lde/search-typesense to 0.21.3
- Updated @lde/search-pipeline to 0.18.4
- Updated @lde/search to 0.18.3

## 0.6.3 (2026-08-12)

### 🧱 Updated Dependencies

- Updated @lde/search-typesense to 0.21.2
- Updated @lde/search-pipeline to 0.18.3
- Updated @lde/search to 0.18.2

## 0.6.2 (2026-08-12)

### 🧱 Updated Dependencies

- Updated @lde/search-typesense to 0.21.1
- Updated @lde/search-pipeline to 0.18.2
- Updated @lde/search to 0.18.1

## 0.6.1 (2026-08-12)

### 🚀 Features

- **search-indexer:** add a transform without forking the composition ([#720](https://github.com/ldelements/lde/pull/720))

### 🧱 Updated Dependencies

- Updated @lde/search-pipeline to 0.18.1

## 0.6.0 (2026-08-07)

### 🧱 Updated Dependencies

- Updated @lde/search-typesense to 0.21.0
- Updated @lde/search-pipeline to 0.18.0
- Updated @lde/search to 0.18.0

## 0.5.0 (2026-08-07)

### 🧱 Updated Dependencies

- Updated @lde/search-typesense to 0.20.0
- Updated @lde/search-pipeline to 0.17.0
- Updated @lde/search to 0.17.0

## 0.4.0 (2026-08-07)

### 🧱 Updated Dependencies

- Updated @lde/search-typesense to 0.19.0
- Updated @lde/search-pipeline to 0.16.0
- Updated @lde/search to 0.16.0

## 0.3.2 (2026-08-07)

### 🧱 Updated Dependencies

- Updated @lde/pipeline-console-reporter to 0.26.6
- Updated @lde/search-typesense to 0.18.2
- Updated @lde/search-pipeline to 0.15.2
- Updated @lde/pipeline to 0.35.6

## 0.3.1 (2026-08-07)

### 🚀 Features

- **search-pipeline:** extract root types from the dataset registry ([#698](https://github.com/ldelements/lde/pull/698))

### 🧱 Updated Dependencies

- Updated @lde/pipeline-console-reporter to 0.26.5
- Updated @lde/search-typesense to 0.18.1
- Updated @lde/search-pipeline to 0.15.1
- Updated @lde/pipeline to 0.35.5

## 0.3.0 (2026-07-31)

### 🚀 Features

- ⚠️  **search:** serve a surfaced inline reference as a nested document ([#689](https://github.com/ldelements/lde/pull/689))

### ⚠️  Breaking Changes

- **search:** serve a surfaced inline reference as a nested document  ([#689](https://github.com/ldelements/lde/pull/689))

### 🧱 Updated Dependencies

- Updated @lde/search-typesense to 0.18.0
- Updated @lde/search-pipeline to 0.15.0
- Updated @lde/search to 0.15.0

## 0.2.0 (2026-07-31)

### 🧱 Updated Dependencies

- Updated @lde/search-typesense to 0.17.0
- Updated @lde/search-pipeline to 0.14.0
- Updated @lde/search to 0.14.0

## 0.1.0 (2026-07-30)

### 🧱 Updated Dependencies

- Updated @lde/search-typesense to 0.16.0
- Updated @lde/search-pipeline to 0.13.0
- Updated @lde/search to 0.13.0

## 0.0.4 (2026-07-27)

### 🧱 Updated Dependencies

- Updated @lde/search-typesense to 0.15.6
- Updated @lde/search-pipeline to 0.12.6
- Updated @lde/search to 0.12.3

## 0.0.3 (2026-07-25)

### 🚀 Features

- **sparql-qlever:** reach QLever by container name over a Docker network ([#663](https://github.com/ldelements/lde/pull/663))

### 🧱 Updated Dependencies

- Updated @lde/sparql-qlever to 0.15.3

## 0.0.2 (2026-07-25)

### 🩹 Fixes

- **pipeline:** fail fast when the provenance store cannot persist records ([#662](https://github.com/ldelements/lde/pull/662))

### 🧱 Updated Dependencies

- Updated @lde/pipeline-console-reporter to 0.26.4
- Updated @lde/search-typesense to 0.15.5
- Updated @lde/search-pipeline to 0.12.5
- Updated @lde/pipeline to 0.35.4

## 0.0.1 (2026-07-24)

### 🚀 Features

- **search-api-server:** serve the search API as a bootable process and Docker image ([#646](https://github.com/ldelements/lde/pull/646), [#655](https://github.com/ldelements/lde/issues/655))

### 🧱 Updated Dependencies

- Updated @lde/pipeline-console-reporter to 0.26.3
- Updated @lde/dataset-registry-client to 0.9.1
- Updated @lde/search-typesense to 0.15.4
- Updated @lde/search-pipeline to 0.12.4
- Updated @lde/sparql-qlever to 0.15.2
- Updated @lde/pipeline to 0.35.3
- Updated @lde/search to 0.12.2