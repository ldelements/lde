## 0.9.0 (2026-11-03)

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

### 🧱 Updated Dependencies

- Updated @lde/dataset to 0.10.0

## 0.8.0 (2026-10-30)

### 🧱 Updated Dependencies

- Updated @lde/dataset to 0.9.0

## 0.7.0 (2026-10-15)

### 🧱 Updated Dependencies

- Updated @lde/dataset to 0.8.0

## 0.6.10 (2026-10-14)

### 🧱 Updated Dependencies

- Updated @lde/dataset to 0.7.10

## 0.6.9 (2026-09-09)

### 🩹 Fixes

- **distribution-downloader:** time out on a stalled transfer instead of a slow one ([#835](https://github.com/ldelements/lde/pull/835))

## 0.6.8 (2026-07-24)

### 🧱 Updated Dependencies

- Updated @lde/dataset to 0.7.9

## 0.6.7 (2026-07-23)

### 🩹 Fixes

- **distribution-downloader:** create the download target directory ([5c03db2](https://github.com/ldelements/lde/commit/5c03db2))

## 0.6.6 (2026-06-26)

### 🧱 Updated Dependencies

- Updated @lde/dataset to 0.7.8

## 0.6.5 (2026-06-15)

### 🧱 Updated Dependencies

- Updated @lde/dataset to 0.7.7

## 0.6.4 (2026-06-15)

### 🧱 Updated Dependencies

- Updated @lde/dataset to 0.7.6

## 0.6.3 (2026-06-10)

### 🧱 Updated Dependencies

- Updated @lde/dataset to 0.7.5

## 0.6.2 (2026-05-21)

### 🧱 Updated Dependencies

- Updated @lde/dataset to 0.7.4

## 0.6.1 (2026-04-23)

### 🧱 Updated Dependencies

- Updated @lde/dataset to 0.7.3

## 0.6.0 (2026-03-22)

### 🚀 Features

- ⚠️  detect and correct MIME type mismatches in distribution imports ([#291](https://github.com/ldelements/lde/pull/291))

### ⚠️  Breaking Changes

- detect and correct MIME type mismatches in distribution imports  ([#291](https://github.com/ldelements/lde/pull/291))
  Downloader.download() returns DownloadResult instead
  of string; qleverOptions on createQlever() renamed to indexOptions.

### ❤️ Thank You

- David de Boer @ddeboer

## 0.5.3 (2026-03-16)

### 🩹 Fixes

- **distribution-downloader:** add path containment check for download target ([e98931f](https://github.com/ldelements/lde/commit/e98931f))

### 🧱 Updated Dependencies

- Updated @lde/dataset to 0.7.2

### ❤️ Thank You

- David de Boer @ddeboer

## 0.5.2 (2026-03-16)

### 🩹 Fixes

- **distribution-downloader:** add fetch timeout, clean up partial downloads on failure ([959de34](https://github.com/ldelements/lde/commit/959de34))

### ❤️ Thank You

- David de Boer @ddeboer

## 0.5.1 (2026-03-06)

### 🧱 Updated Dependencies

- Updated @lde/dataset to 0.7.1

## 0.5.0 (2026-02-27)

### 🧱 Updated Dependencies

- Updated @lde/dataset to 0.7.0

## 0.4.11 (2026-02-16)

### 🧱 Updated Dependencies

- Updated @lde/dataset to 0.6.10

## 0.4.10 (2026-02-13)

### 🧱 Updated Dependencies

- Updated @lde/dataset to 0.6.9

## 0.4.9 (2026-02-13)

This was a version bump only for @lde/distribution-downloader to align it with other projects, there were no code changes.

## 0.4.8 (2026-02-11)

### 🧱 Updated Dependencies

- Updated @lde/dataset to 0.6.8

## 0.4.7 (2026-02-11)

### 🧱 Updated Dependencies

- Updated @lde/dataset to 0.6.7

## 0.4.6 (2026-02-09)

### 🧱 Updated Dependencies

- Updated @lde/dataset to 0.6.6

## 0.4.5 (2026-02-09)

### 🧱 Updated Dependencies

- Updated @lde/dataset to 0.6.5

## 0.4.4 (2026-02-09)

### 🧱 Updated Dependencies

- Updated @lde/dataset to 0.6.4

## 0.4.3 (2026-02-09)

### 🧱 Updated Dependencies

- Updated @lde/dataset to 0.6.3

## 0.4.2 (2026-02-09)

### 🧱 Updated Dependencies

- Updated @lde/dataset to 0.6.2

## 0.4.1 (2026-02-09)

### 🧱 Updated Dependencies

- Updated @lde/dataset to 0.6.1

## 0.4.0 (2026-02-07)

### 🚀 Features

- add pipeline-void package and extend pipeline with analyzers, writers, and SPARQL utilities ([#48](https://github.com/ldelements/lde/pull/48))

### 🧱 Updated Dependencies

- Updated @lde/dataset to 0.6.0

### ❤️ Thank You

- David de Boer @ddeboer

## 0.3.0 (2026-02-06)

### 🧱 Updated Dependencies

- Updated @lde/dataset to 0.5.0

## 0.2.7 (2025-10-09)

### 🧱 Updated Dependencies

- Updated @lde/dataset to 0.4.2

## 0.2.6 (2025-10-06)

### 🩹 Fixes

- add repository URL ([88641bf](https://github.com/ldelements/lde/commit/88641bf))

### ❤️ Thank You

- David de Boer @ddeboer

## 0.2.5 (2025-10-06)

### 🧱 Updated Dependencies

- Updated @lde/dataset to 0.4.1

## 0.2.4 (2025-10-06)

### 🧱 Updated Dependencies

- Updated @lde/dataset to 0.4.0

## 0.2.3 (2025-08-07)

### 🩹 Fixes

- rename distribution-download to distribution-downloader ([#29](https://github.com/ldelements/lde/pull/29))

### ❤️ Thank You

- David de Boer @ddeboer

## 0.2.2 (2025-07-31)

### 🩹 Fixes

- standardize exports field order in all packages ([#20](https://github.com/ldelements/lde/pull/20))

### 🧱 Updated Dependencies

- Updated @lde/dataset to 0.3.1

### ❤️ Thank You

- David de Boer @ddeboer

## 0.2.1 (2025-07-29)

### 🧱 Updated Dependencies

- Updated @lde/dataset to 0.3.0

## 0.2.0 (2025-07-28)

### 🚀 Features

- add pipeline ([#11](https://github.com/ldelements/lde/pull/11))

### 🩹 Fixes

- download module and its tests ([2690318](https://github.com/ldelements/lde/commit/2690318))
- add dataset ([517c270](https://github.com/ldelements/lde/commit/517c270))

### 🧱 Updated Dependencies

- Updated @lde/dataset to 0.2.0

### ❤️ Thank You

- David de Boer @ddeboer
