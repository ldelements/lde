## 0.6.0 (2026-11-11)

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

### 🧱 Updated Dependencies

- Updated @lde/host-limiter to 0.4.0

## 0.5.0 (2026-11-10)

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

### 🧱 Updated Dependencies

- Updated @lde/host-limiter to 0.3.0

## 0.4.0 (2026-11-10)

### 🚀 Features

- ⚠️  **pipeline:** report where a stage spent its time and what it counted ([#1041](https://github.com/ldelements/lde/pull/1041))

### ⚠️  Breaking Changes

- **pipeline:** report where a stage spent its time and what it counted  ([#1041](https://github.com/ldelements/lde/pull/1041))
  ReaderContext.count is a required member. Code that
  builds a ReaderContext or BatchContext by hand, such as a transform
  test, must add it, e.g. count: () => undefined."
  M	docs/reference/pipeline.md
  M	docs/reference/resolver.md
  M	packages/pipeline-console-reporter/src/consoleReporter.ts
  M	packages/pipeline-console-reporter/test/consoleReporter.test.ts
  M	packages/pipeline-console-reporter/vite.config.ts
  M	packages/pipeline-void/test/uriSpaceTransform.test.ts
  M	packages/pipeline-void/test/vocabularyTransform.test.ts
  M	packages/pipeline/src/pipeline.ts
  M	packages/pipeline/src/pipelineEvent.ts
  M	packages/pipeline/src/stage.ts
  A	packages/pipeline/src/stageTally.ts
  M	packages/pipeline/test/pipeline.test.ts
  M	packages/pipeline/test/stage.test.ts
  M	packages/pipeline/vite.config.ts
  M	packages/resolver/src/index.ts
  M	packages/resolver/src/resolver.ts
  M	packages/resolver/test/resolver.test.ts

## 0.3.0 (2026-11-10)

### 🚀 Features

- ⚠️  **resolver:** retry within a run only what a retry can fix ([#1026](https://github.com/ldelements/lde/pull/1026))

### ⚠️  Breaking Changes

- **resolver:** retry within a run only what a retry can fix  ([#1026](https://github.com/ldelements/lde/pull/1026))
  the retries and retryDelayMs limits are removed; throw
  RetryableError for a failure worth retrying. A plain throw is no longer
  retried. timeoutMs defaults to 10 s instead of 30 s; raise it for a source
  that needs longer. hostFailureThreshold now counts failures among a host’s
  last 2 × threshold batches, not consecutive ones.
  * docs(resolver): state precisely what the breaker counts and what a pause stops
  - Say what counts as a success, a failure or neither for the breaker
  - Say that a dead host also costs the batches already in flight
  - Say when a stall is counted, and what happens if its host is written off
    before its second attempt
  - Say that a pause stops new attempts only, and that a failed RetryableError
    counts against the host
  * fix(resolver): keep a contacted batch’s charge and reason, and spot every timeout
  - A batch waiting out a Retry-After keeps its charge and its 429 reason
    when its host is written off, as a stalled batch already did
  - Read an attempt as timed out whenever the resolver’s own signal fired,
    even when the caller’s abort error wins the race
  - Back off on Retry-After: 0 or a past date instead of retrying at once
  - Stop feeding the breaker for a host already written off
  - Make the docs example throw on 502, 503 and 504 instead of failing the
    reference
  * fix(resolver): take back a stall’s failure when its second attempt is answered
  - A stall still counts against its host when it first fails, so a dead
    host is written off early, but an answered second attempt turns that
    failure back into a success
  - A brief slowdown therefore no longer writes off a host that recovers,
    unless enough stalls pile up before any second attempt comes round"
  M	docs/decisions/0023-resolve-external-references-in-a-standalone-library.md
  M	docs/reference/resolver.md
  M	packages/resolver/README.md
  A	packages/resolver/src/failures.ts
  M	packages/resolver/src/index.ts
  M	packages/resolver/src/resolver.ts
  M	packages/resolver/test/resolver.test.ts

## 0.2.1 (2026-10-31)

### 🩹 Fixes

- **resolver:** hold concurrency limits across resolveAll calls ([#982](https://github.com/ldelements/lde/pull/982))

### 🧱 Updated Dependencies

- Updated @lde/host-limiter to 0.2.1

## 0.2.0 (2026-10-30)

### 🧱 Updated Dependencies

- Updated @lde/host-limiter to 0.2.0

## 0.1.0 (2026-10-15)

### 🧱 Updated Dependencies

- Updated @lde/host-limiter to 0.1.0

## 0.0.2 (2026-10-14)

### 🧱 Updated Dependencies

- Updated @lde/host-limiter to 0.0.2

## 0.0.1 (2026-08-24)

### 🚀 Features

- **resolver:** resolve external references with bounds, persistence and isolation ([4ee5cb84b](https://github.com/ldelements/lde/commit/4ee5cb84b))

### 🧱 Updated Dependencies

- Updated @lde/host-limiter to 0.0.1