## 0.4.0 (2026-11-11)

### 🧱 Updated Dependencies

- Updated @lde/pipeline to 0.47.0

## 0.3.0 (2026-11-10)

### 🧱 Updated Dependencies

- Updated @lde/pipeline to 0.46.0

## 0.2.0 (2026-11-10)

### 🧱 Updated Dependencies

- Updated @lde/pipeline to 0.45.0

## 0.1.0 (2026-11-10)

### 🚀 Features

- ⚠️  **pipeline:** support structured event by reworking event logging ([df86a6de3](https://github.com/ldelements/lde/commit/df86a6de3))

### ⚠️  Breaking Changes

- **pipeline:** support structured event by reworking event logging  ([df86a6de3](https://github.com/ldelements/lde/commit/df86a6de3))
  ProgressReporter and combineReporters are replaced by
  Reporter, whose onEvent receives a PipelineEvent. Durations are renamed to
  durationMs, including ImportDetails.durationMs, and
  ResolveCallbacks.onImportFailed now receives an Error instead of a string."
  M	README.md
  M	docs/.vitepress/config.mts
  A	docs/decisions/0034-emit-pipeline-events-as-one-levelled-union.md
  M	docs/guide/architecture.md
  M	docs/guide/core-concepts.md
  M	docs/guide/observe-a-run-with-a-reporter.md
  M	docs/guide/validate-pipeline-output.md
  M	docs/reference/packages.md
  M	docs/reference/pipeline-console-reporter.md
  A	docs/reference/pipeline-logger-reporter.md
  M	docs/reference/pipeline.md
  M	docs/reference/search-typesense.md
  M	package-lock.json
  M	packages/pipeline-console-reporter/package.json
  M	packages/pipeline-console-reporter/src/consoleReporter.ts
  M	packages/pipeline-console-reporter/test/consoleReporter.test.ts
  M	packages/pipeline-console-reporter/vite.config.ts
  A	packages/pipeline-logger-reporter/README.md
  A	packages/pipeline-logger-reporter/eslint.config.mjs
  A	packages/pipeline-logger-reporter/package.json
  A	packages/pipeline-logger-reporter/src/index.ts
  A	packages/pipeline-logger-reporter/src/loggerReporter.ts
  A	packages/pipeline-logger-reporter/test/loggerReporter.test.ts
  A	packages/pipeline-logger-reporter/tsconfig.json
  A	packages/pipeline-logger-reporter/tsconfig.lib.json
  A	packages/pipeline-logger-reporter/tsconfig.spec.json
  A	packages/pipeline-logger-reporter/vite.config.ts
  D	packages/pipeline/src/combineReporters.ts
  M	packages/pipeline/src/distribution/importResolver.ts
  M	packages/pipeline/src/distribution/resolver.ts
  M	packages/pipeline/src/index.ts
  M	packages/pipeline/src/pipeline.ts
  A	packages/pipeline/src/pipelineEvent.ts
  D	packages/pipeline/src/progressReporter.ts
  A	packages/pipeline/src/reporter.ts
  M	packages/pipeline/src/sparql/reader.ts
  M	packages/pipeline/src/stage.ts
  M	packages/pipeline/src/unreadValueTally.ts
  M	packages/pipeline/src/writer/writer.ts
  D	packages/pipeline/test/combineReporters.test.ts
  M	packages/pipeline/test/distribution/importResolver.test.ts
  M	packages/pipeline/test/pipeline.test.ts
  A	packages/pipeline/test/pipelineEvent.test.ts
  M	packages/pipeline/vite.config.ts
  M	packages/search-pipeline/src/search-indexer-pipeline.ts
  M	packages/search-pipeline/test/joins.integration.test.ts
  M	packages/search-pipeline/test/search-indexer-pipeline.integration.test.ts
  M	tsconfig.json

### 🧱 Updated Dependencies

- Updated @lde/pipeline to 0.44.0