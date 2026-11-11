## 0.6.0 (2026-11-10)

### 🧱 Updated Dependencies

- Updated @lde/host-limiter to 0.3.0

## 0.5.1 (2026-11-09)

### 🧱 Updated Dependencies

- Updated @lde/dataset to 0.10.1

## 0.5.0 (2026-11-03)

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

## 0.4.1 (2026-10-31)

### 🧱 Updated Dependencies

- Updated @lde/host-limiter to 0.2.1

## 0.4.0 (2026-10-30)

### 🧱 Updated Dependencies

- Updated @lde/host-limiter to 0.2.0
- Updated @lde/dataset to 0.9.0

## 0.3.2 (2026-10-28)

This was a version bump only for @lde/distribution-probe to align it with other projects, there were no code changes.

## 0.3.1 (2026-10-27)

### 🚀 Features

- let consumers replace remote JSON-LD contexts ([#962](https://github.com/ldelements/lde/pull/962))

## 0.3.0 (2026-10-15)

### 🧱 Updated Dependencies

- Updated @lde/host-limiter to 0.1.0
- Updated @lde/dataset to 0.8.0

## 0.2.10 (2026-10-14)

### 🧱 Updated Dependencies

- Updated @lde/host-limiter to 0.0.2
- Updated @lde/dataset to 0.7.10

## 0.2.9 (2026-08-24)

### 🚀 Features

- **resolver:** resolve external references with bounds, persistence and isolation ([4ee5cb84b](https://github.com/ldelements/lde/commit/4ee5cb84b))

### 🧱 Updated Dependencies

- Updated @lde/host-limiter to 0.0.1

## 0.2.8 (2026-08-24)

This was a version bump only for @lde/distribution-probe to align it with other projects, there were no code changes.

## 0.2.7 (2026-07-24)

### 🧱 Updated Dependencies

- Updated @lde/dataset to 0.7.9

## 0.2.6 (2026-07-08)

This was a version bump only for @lde/distribution-probe to align it with other projects, there were no code changes.

## 0.2.5 (2026-07-08)

### 🩹 Fixes

- **distribution-probe:** attach parser error sink before tearing down on budget abort ([#571](https://github.com/ldelements/lde/pull/571), [#570](https://github.com/ldelements/lde/issues/570))

## 0.2.4 (2026-07-08)

### 🩹 Fixes

- **distribution-probe:** make RDF-validation coverage deterministic ([#570](https://github.com/ldelements/lde/pull/570))

## 0.2.3 (2026-06-26)

### 🧱 Updated Dependencies

- Updated @lde/dataset to 0.7.8

## 0.2.2 (2026-06-26)

### 🚀 Features

- **distribution-probe:** add onProgress callback to probeMany ([#527](https://github.com/ldelements/lde/pull/527))

## 0.2.1 (2026-06-25)

### 🚀 Features

- **distribution-probe:** add probeMany with global and per-host concurrency caps ([362788a8](https://github.com/ldelements/lde/commit/362788a8))

## 0.2.0 (2026-06-22)

### 🚀 Features

- ⚠️  **distribution-probe:** bounded-stream reads with opt-in RDF content validation ([#507](https://github.com/ldelements/lde/pull/507), [#505](https://github.com/ldelements/lde/issues/505))

### ⚠️  Breaking Changes

- **distribution-probe:** bounded-stream reads with opt-in RDF content validation  ([#507](https://github.com/ldelements/lde/pull/507), [#505](https://github.com/ldelements/lde/issues/505))
  data-dump bodies are no longer content-validated by
  default. Callers that relied on the probe rejecting empty or triple-less
  dumps must now pass validateRdfContent: true.

## 0.1.13 (2026-06-19)

This was a version bump only for @lde/distribution-probe to align it with other projects, there were no code changes.

## 0.1.12 (2026-06-18)

### 🩹 Fixes

- **distribution-probe:** accept empty and non-n-triples SPARQL CONSTRUCT answers ([#488](https://github.com/ldelements/lde/pull/488))

## 0.1.11 (2026-06-17)

### 🚀 Features

- **distribution-probe:** retry transport errors before reporting unavailable ([#487](https://github.com/ldelements/lde/pull/487))

## 0.1.10 (2026-06-15)

### 🧱 Updated Dependencies

- Updated @lde/dataset to 0.7.7

## 0.1.9 (2026-06-15)

### 🩹 Fixes

- **distribution-probe:** accept declared compressed media type for gzipped downloads ([#466](https://github.com/ldelements/lde/pull/466))

### 🧱 Updated Dependencies

- Updated @lde/dataset to 0.7.6

## 0.1.8 (2026-06-10)

### 🧱 Updated Dependencies

- Updated @lde/dataset to 0.7.5

## 0.1.7 (2026-06-08)

### 🩹 Fixes

- **distribution-probe:** match distribution content type case-insensitively ([#442](https://github.com/ldelements/lde/pull/442))

## 0.1.6 (2026-06-08)

### 🚀 Features

- **distribution-probe:** detect empty RDF distributions across serializations ([#441](https://github.com/ldelements/lde/pull/441))

## 0.1.5 (2026-06-01)

### 🩹 Fixes

- **distribution-probe:** accept SPARQL results as JSON or XML ([#425](https://github.com/ldelements/lde/pull/425))

## 0.1.4 (2026-05-27)

### 🩹 Fixes

- **distribution-probe:** tolerate servers that 406 on specific Accept headers ([#410](https://github.com/ldelements/lde/pull/410), [#12410](https://github.com/ldelements/lde/issues/12410))

## 0.1.3 (2026-05-21)

### 🚀 Features

- **sparql-qlever:** support JSON-LD and zipped distributions ([bdf48f0](https://github.com/ldelements/lde/commit/bdf48f0))

### 🧱 Updated Dependencies

- Updated @lde/dataset to 0.7.4

## 0.1.2 (2026-04-23)

### 🚀 Features

- consolidate probing, rename sparql-monitor to distribution-monitor ([#358](https://github.com/ldelements/lde/pull/358))

### 🧱 Updated Dependencies

- Updated @lde/dataset to 0.7.3

## 0.1.1 (2026-04-23)

This was a version bump only for @lde/distribution-probe to align it with other projects, there were no code changes.