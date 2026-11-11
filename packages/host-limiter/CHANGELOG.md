## 0.4.0 (2026-11-11)

### 🚀 Features

- ⚠️  **pipeline:** run reader queries on a shared, adaptive host limiter ([#1052](https://github.com/ldelements/lde/pull/1052))

### ⚠️  Breaking Changes

- **pipeline:** run reader queries on a shared, adaptive host limiter  ([#1052](https://github.com/ldelements/lde/pull/1052))
  SparqlConstructReaderOptions.retries is removed; the reader’s backoff is
  fixed. Pass a limiter to Pipeline to set how many queries reach an endpoint at once."
  M	docs/reference/host-limiter.md
  M	docs/reference/pipeline.md
  M	docs/reference/resolver.md
  M	package-lock.json
  M	packages/host-limiter/src/index.ts
  A	packages/host-limiter/src/retryAfter.ts
  A	packages/host-limiter/test/retryAfter.test.ts
  M	packages/pipeline-console-reporter/src/consoleReporter.ts
  M	packages/pipeline-console-reporter/test/consoleReporter.test.ts
  M	packages/pipeline-console-reporter/vite.config.ts
  M	packages/pipeline/package.json
  M	packages/pipeline/src/pipeline.ts
  M	packages/pipeline/src/pipelineEvent.ts
  A	packages/pipeline/src/sparql/failure.ts
  M	packages/pipeline/src/sparql/reader.ts
  M	packages/pipeline/src/sparql/selector.ts
  M	packages/pipeline/src/sparql/timeoutPolicy.ts
  M	packages/pipeline/src/stage.ts
  M	packages/pipeline/test/pipeline.test.ts
  M	packages/pipeline/test/sparql/reader.test.ts
  M	packages/pipeline/test/stage.test.ts
  M	packages/pipeline/tsconfig.lib.json
  M	packages/pipeline/vite.config.ts
  M	packages/resolver/src/failures.ts
  M	packages/resolver/src/index.ts
  M	packages/resolver/src/resolver.ts
  M	packages/resolver/test/resolver.test.ts

## 0.3.0 (2026-11-10)

### 🚀 Features

- ⚠️  adapt each host’s limit to how the host responds, in the limiter and the resolver ([#1043](https://github.com/ldelements/lde/pull/1043))

### ⚠️  Breaking Changes

- adapt each host’s limit to how the host responds, in the limiter and the resolver  ([#1043](https://github.com/ldelements/lde/pull/1043))
  the per-host limit of createHostLimiter and mapHostLimited is now a ceiling that
  each host starts below, at one task in flight; HostLimiter gains pause, and run hands its task a
  slot. The resolver limits concurrency and perHostConcurrency are removed: pass
  limiter: createHostLimiter(global, perHost) instead."
  M	README.md
  M	docs/reference/host-limiter.md
  M	docs/reference/resolver.md
  M	packages/host-limiter/README.md
  M	packages/host-limiter/package.json
  M	packages/host-limiter/src/index.ts
  M	packages/host-limiter/src/mapHostLimited.ts
  M	packages/host-limiter/test/mapHostLimited.test.ts
  M	packages/resolver/src/resolver.ts
  M	packages/resolver/test/resolver.test.ts

## 0.2.1 (2026-10-31)

### 🩹 Fixes

- **resolver:** hold concurrency limits across resolveAll calls ([#982](https://github.com/ldelements/lde/pull/982))

## 0.2.0 (2026-10-30)

This was a version bump only for @lde/host-limiter to align it with other projects, there were no code changes.

## 0.1.0 (2026-10-15)

This was a version bump only for @lde/host-limiter to align it with other projects, there were no code changes.

## 0.0.2 (2026-10-14)

This was a version bump only for @lde/host-limiter to align it with other projects, there were no code changes.

## 0.0.1 (2026-08-24)

### 🚀 Features

- **resolver:** resolve external references with bounds, persistence and isolation ([4ee5cb84b](https://github.com/ldelements/lde/commit/4ee5cb84b))