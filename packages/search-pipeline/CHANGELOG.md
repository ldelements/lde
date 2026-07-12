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