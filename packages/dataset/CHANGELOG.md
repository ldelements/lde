## 0.10.1 (2026-11-09)

### 🩹 Fixes

- **dataset:** refuse every character a SPARQL IRI reference excludes ([#1011](https://github.com/ldelements/lde/pull/1011))

## 0.10.0 (2026-11-03)

### 🚀 Features

- ⚠️  **search-indexer:** index local RDF files beside registered datasets ([#985](https://github.com/ldelements/lde/pull/985))

### ⚠️  Breaking Changes

- **search-indexer:** index local RDF files beside registered datasets  ([#985](https://github.com/ldelements/lde/pull/985))
  IndexerConfig.registryEndpoint is optional, undefined
  when DATASETS names only local data. Code reading it must handle
  undefined.
  * fix: re-copy restored local files and isolate combined selections
  - Record a local file’s size and modification time beside its copy and
    copy again whenever either changes, so a same-size replacement restored
    with an older time reaches the index
  - Cancel a local copy when the download signal aborts
  - Give each iteration of a CombinedSelector selection its own stream, so
    overlapping or restarted loops never skip or repeat datasets
  - Stop Dataset.localFile sharing one URL object between the IRI and the
    access URL
  - Test RegistrySelector
  - Argue the full directory listing against ADR 12 in ADR 31, and note
    that an own IRI counts as registered for registry-sourced types"
  A	docs/decisions/0031-import-local-files-through-the-data-dump-path.md
  M	docs/guide/import-data-dumps.md
  M	docs/guide/what-is-lde.md
  M	docs/reference/dataset.md
  M	docs/reference/distribution-downloader.md
  M	docs/reference/distribution-probe.md
  M	docs/reference/pipeline.md
  M	docs/reference/search-indexer.md
  M	docs/reference/search-pipeline.md
  M	package-lock.json
  M	packages/dataset/src/dataset.ts
  M	packages/dataset/src/distribution.ts
  A	packages/dataset/test/dataset.test.ts
  M	packages/dataset/test/distribution.test.ts
  M	packages/distribution-downloader/src/download.ts
  A	packages/distribution-downloader/test/localFile.test.ts
  M	packages/distribution-downloader/vite.config.ts
  M	packages/distribution-probe/src/probe.ts
  A	packages/distribution-probe/test/localFile.test.ts
  M	packages/distribution-probe/vite.config.ts
  M	packages/pipeline/src/selector.ts
  A	packages/pipeline/test/directorySelector.test.ts
  A	packages/pipeline/test/distribution/localFile.test.ts
  A	packages/pipeline/test/selector.test.ts
  M	packages/pipeline/vite.config.ts
  M	packages/search-indexer/package.json
  M	packages/search-indexer/src/cli.ts
  M	packages/search-indexer/src/composition.ts
  M	packages/search-indexer/src/config.ts
  M	packages/search-indexer/src/indexer.ts
  M	packages/search-indexer/test/composition.test.ts
  M	packages/search-indexer/test/config.test.ts
  M	packages/search-indexer/tsconfig.lib.json
  M	packages/search-pipeline/src/search-stages.ts
  M	packages/search-pipeline/test/search-stages.test.ts

## 0.9.0 (2026-10-30)

This was a version bump only for @lde/dataset to align it with other projects, there were no code changes.

## 0.8.0 (2026-10-15)

This was a version bump only for @lde/dataset to align it with other projects, there were no code changes.

## 0.7.10 (2026-10-14)

This was a version bump only for @lde/dataset to align it with other projects, there were no code changes.

## 0.7.9 (2026-07-24)

This was a version bump only for @lde/dataset to align it with other projects, there were no code changes.

## 0.7.8 (2026-06-26)

This was a version bump only for @lde/dataset to align it with other projects, there were no code changes.

## 0.7.7 (2026-06-15)

### 🩹 Fixes

- skolemize structural nodes to prevent blank-node collisions in merged graphs ([#471](https://github.com/ldelements/lde/pull/471), [#352](https://github.com/ldelements/lde/issues/352), [#474](https://github.com/ldelements/lde/issues/474))

## 0.7.6 (2026-06-15)

### 🩹 Fixes

- **distribution-probe:** accept declared compressed media type for gzipped downloads ([#466](https://github.com/ldelements/lde/pull/466))

## 0.7.5 (2026-06-10)

### 🚀 Features

- **dataset:** accept application/rdf+xml as an RDF media type ([#449](https://github.com/ldelements/lde/pull/449))

## 0.7.4 (2026-05-21)

### 🚀 Features

- **sparql-qlever:** support JSON-LD and zipped distributions ([bdf48f0](https://github.com/ldelements/lde/commit/bdf48f0))

## 0.7.3 (2026-04-23)

This was a version bump only for @lde/dataset to align it with other projects, there were no code changes.

## 0.7.2 (2026-03-16)

### 🩹 Fixes

- **dataset:** guard SPARQL IRI interpolation against injection ([99933a7](https://github.com/ldelements/lde/commit/99933a7))

### ❤️ Thank You

- David de Boer @ddeboer

## 0.7.1 (2026-03-06)

### 🩹 Fixes

- **dataset:** exclude SPARQL endpoint distributions from getDownloadDistributions() ([#210](https://github.com/ldelements/lde/pull/210))

### ❤️ Thank You

- David de Boer @ddeboer

## 0.7.0 (2026-02-27)

### 🚀 Features

- **dataset:** replace +gzip media types with dcat:compressFormat ([#167](https://github.com/ldelements/lde/pull/167))

### ❤️ Thank You

- David de Boer @ddeboer

## 0.6.10 (2026-02-16)

This was a version bump only for @lde/dataset to align it with other projects, there were no code changes.

## 0.6.9 (2026-02-13)

This was a version bump only for @lde/dataset to align it with other projects, there were no code changes.

## 0.6.8 (2026-02-11)

This was a version bump only for @lde/dataset to align it with other projects, there were no code changes.

## 0.6.7 (2026-02-11)

This was a version bump only for @lde/dataset to align it with other projects, there were no code changes.

## 0.6.6 (2026-02-09)

This was a version bump only for @lde/dataset to align it with other projects, there were no code changes.

## 0.6.5 (2026-02-09)

This was a version bump only for @lde/dataset to align it with other projects, there were no code changes.

## 0.6.4 (2026-02-09)

This was a version bump only for @lde/dataset to align it with other projects, there were no code changes.

## 0.6.3 (2026-02-09)

This was a version bump only for @lde/dataset to align it with other projects, there were no code changes.

## 0.6.2 (2026-02-09)

This was a version bump only for @lde/dataset to align it with other projects, there were no code changes.

## 0.6.1 (2026-02-09)

This was a version bump only for @lde/dataset to align it with other projects, there were no code changes.

## 0.6.0 (2026-02-07)

This was a version bump only for @lde/dataset to align it with other projects, there were no code changes.

## 0.5.0 (2026-02-06)

This was a version bump only for @lde/dataset to align it with other projects, there were no code changes.

## 0.4.2 (2025-10-09)

### 🩹 Fixes

- make distribution mediaType optional ([#35](https://github.com/ldelements/lde/pull/35))

### ❤️ Thank You

- David de Boer @ddeboer

## 0.4.1 (2025-10-06)

### 🩹 Fixes

- add repository URL, required for provenance ([bc1cfd5](https://github.com/ldelements/lde/commit/bc1cfd5))

### ❤️ Thank You

- David de Boer @ddeboer

## 0.4.0 (2025-10-06)

### 🚀 Features

- use SPARQL protocol URI for conformsTo ([#34](https://github.com/ldelements/lde/pull/34))

### ❤️ Thank You

- David de Boer @ddeboer

## 0.3.1 (2025-07-31)

### 🩹 Fixes

- standardize exports field order in all packages ([#20](https://github.com/ldelements/lde/pull/20))

### ❤️ Thank You

- David de Boer @ddeboer

## 0.3.0 (2025-07-29)

### 🚀 Features

- extend dataset properties ([#15](https://github.com/ldelements/lde/pull/15))

### ❤️ Thank You

- David de Boer @ddeboer

## 0.2.0 (2025-07-28)

### 🚀 Features

- add pipeline ([#11](https://github.com/ldelements/lde/pull/11))

### 🩹 Fixes

- add dataset ([517c270](https://github.com/ldelements/lde/commit/517c270))

### ❤️ Thank You

- David de Boer @ddeboer