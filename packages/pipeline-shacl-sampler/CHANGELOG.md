## 0.9.2 (2026-07-24)

### 🩹 Fixes

- **pipeline:** count fetched rows for selector pagination ([#653](https://github.com/ldelements/lde/pull/653))

### 🧱 Updated Dependencies

- Updated @lde/pipeline to 0.35.2

## 0.9.1 (2026-07-24)

### 🧱 Updated Dependencies

- Updated @lde/pipeline to 0.35.1

## 0.9.0 (2026-07-23)

### 🧱 Updated Dependencies

- Updated @lde/pipeline to 0.35.0

## 0.8.4 (2026-07-23)

### 🧱 Updated Dependencies

- Updated @lde/pipeline to 0.34.4

## 0.8.3 (2026-07-23)

### 🧱 Updated Dependencies

- Updated @lde/pipeline to 0.34.3

## 0.8.2 (2026-07-17)

### 🧱 Updated Dependencies

- Updated @lde/pipeline to 0.34.2

## 0.8.1 (2026-07-12)

### 🧱 Updated Dependencies

- Updated @lde/pipeline to 0.34.1

## 0.8.0 (2026-07-09)

### 🧱 Updated Dependencies

- Updated @lde/pipeline to 0.34.0

## 0.7.4 (2026-07-08)

### 🚀 Features

- **pipeline-void:** merge namespace-alias variants into one VoID partition ([#568](https://github.com/ldelements/lde/pull/568), [#334](https://github.com/ldelements/lde/issues/334))

### 🧱 Updated Dependencies

- Updated @lde/pipeline to 0.33.4

## 0.7.3 (2026-07-08)

### 🧱 Updated Dependencies

- Updated @lde/pipeline to 0.33.3

## 0.7.2 (2026-07-08)

### 🧱 Updated Dependencies

- Updated @lde/pipeline to 0.33.2

## 0.7.1 (2026-07-08)

### 🧱 Updated Dependencies

- Updated @lde/pipeline to 0.33.1

## 0.7.0 (2026-07-08)

### 🧱 Updated Dependencies

- Updated @lde/pipeline to 0.33.0

## 0.6.0 (2026-07-07)

### 🚀 Features

- ⚠️  **pipeline:** transaction-aware Writer and the Executor→Reader rename ([#559](https://github.com/ldelements/lde/pull/559))

### ⚠️  Breaking Changes

- **pipeline:** transaction-aware Writer and the Executor→Reader rename  ([#559](https://github.com/ldelements/lde/pull/559))
  ‘Executor’ is now ‘Reader’ and its ‘execute()’ method
  is ‘read()’. Renamed accordingly: SparqlConstructExecutor →
  SparqlConstructReader, SparqlConstructExecutorOptions →
  SparqlConstructReaderOptions, ExecuteOptions → ReadOptions,
  ExecutorContext → ReaderContext, AttachedExecutor → AttachedReader (its
  ‘executor’ property → ‘reader’), StageExecutors → StageReaders, and
  StageOptions.executors → StageOptions.readers. @lde/pipeline-void
  re-exports the renamed types.
  * feat(pipeline)!: make the Writer transaction-aware
  A Writer is now a factory of per-run transactions: Pipeline.run opens
  one run (openRun(context) → RunWriter), writes every dataset through it,
  and ends it with exactly one commit() or abort(error) – the home of
  run-level lifecycle such as alias swaps, deletion sweeps and cross-pod
  locks. The pipeline never branches on the writer’s update mode. Stages
  write through the narrower DatasetWriter, so a stage can never commit or
  abort the run. RunContext carries runId, startedAt, selectedSources()
  (complete by commit time, including datasets skipped as unchanged) and
  the provenance store. Lifecycle-free destinations wrap a per-dataset
  write with the new perDatasetWriter() helper.
  FileWriter and SparqlUpdateWriter keep per-run state (open files,
  cleared graphs) in the run, so re-running a pipeline on the same writer
  instance replaces output instead of appending – previously a latent bug.
  FileWriter.commit finalizes files still open; abort discards temp
  output. Chained (sub-stage) scratch FileWriters are now flushed before
  their output is resolved. ShaclValidator opens one long-lived run per
  report writer. See docs/decisions/0006.
  BREAKING CHANGE: Writer’s per-dataset write/flush/reset moved to the
  RunWriter returned by the new openRun(context); custom writers implement
  openRun or wrap their per-dataset write with perDatasetWriter(). Generic
  payload: Writer<Item = Quad>. Stage.run now takes a DatasetWriter.
  * refactor(pipeline): tighten the run-transaction internals
  Review cleanups on the transactional Writer:
  - Fan-out commits run concurrently (mirroring abort): destinations are
    independent, so their alias swaps and sweeps – the slowest part of a
    run – no longer queue behind each other. Both share one
    settleBranches helper that rethrows the first failure after every
    branch had its chance.
  - A chained stage’s scratch run is now bracketed like any other run:
    committed on success, aborted on failure – so a failing chained stage
    no longer leaves a stale temp file behind.
  - RunWriter.commit documents the driver contract: every written dataset
    is flushed before commit, so commit-time unflushed writes only occur
    under direct use and should be finalized non-destructively.
  - perDatasetWriter forwards flush/reset with bind instead of manual
    wrapper closures.
  * refactor(pipeline)!: drop the unused perDatasetWriter helper
  No production caller existed – every in-repo destination turned out to
  want real run lifecycle behaviour – so the helper was pure API surface.
  A destination without run-level state implements the same contract with
  a five-line openRun returning no-op commit/abort, as SparqlUpdateWriter
  shows. Coverage thresholds re-baselined after removing fully covered
  code. See docs/decisions/0006."
  M	README.md
  A	docs/decisions/0006-make-the-writer-transaction-aware.md
  M	packages/pipeline-shacl-sampler/src/sampleStages.ts
  M	packages/pipeline-shacl-validator/README.md
  M	packages/pipeline-shacl-validator/src/shacl-validator.ts
  M	packages/pipeline-shacl-validator/test/shacl-validator.test.ts
  M	packages/pipeline-void/README.md
  M	packages/pipeline-void/src/index.ts
  M	packages/pipeline-void/src/stage.ts
  M	packages/pipeline-void/src/uriSpaceTransform.ts
  M	packages/pipeline-void/src/vocabularyTransform.ts
  M	packages/pipeline-void/test/uriSpaceTransform.test.ts
  M	packages/pipeline-void/test/vocabularyTransform.test.ts
  M	packages/pipeline-void/test/voidStages.test.ts
  M	packages/pipeline/README.md
  M	packages/pipeline/src/pipeline.ts
  M	packages/pipeline/src/provenance/fileLoadedSparqlProvenanceStore.ts
  M	packages/pipeline/src/sparql/index.ts
  R088	packages/pipeline/src/sparql/executor.ts	packages/pipeline/src/sparql/reader.ts
  M	packages/pipeline/src/sparql/selector.ts
  M	packages/pipeline/src/sparql/values.ts
  M	packages/pipeline/src/stage.ts
  M	packages/pipeline/src/writer/fileWriter.ts
  M	packages/pipeline/src/writer/sparqlUpdateWriter.ts
  M	packages/pipeline/src/writer/writer.ts
  M	packages/pipeline/test/pipeline.test.ts
  R088	packages/pipeline/test/sparql/executor.test.ts	packages/pipeline/test/sparql/reader.test.ts
  M	packages/pipeline/test/sparql/selector.test.ts
  M	packages/pipeline/test/stage.test.ts
  M	packages/pipeline/test/writer/fileWriter.test.ts
  M	packages/pipeline/test/writer/sparqlUpdateWriter.test.ts
  M	packages/pipeline/vite.config.ts

### 🧱 Updated Dependencies

- Updated @lde/pipeline to 0.32.0

## 0.5.5 (2026-06-26)

### 🧱 Updated Dependencies

- Updated @lde/pipeline to 0.31.5
- Updated @lde/dataset to 0.7.8

## 0.5.4 (2026-06-26)

### 🧱 Updated Dependencies

- Updated @lde/pipeline to 0.31.4

## 0.5.3 (2026-06-25)

### 🧱 Updated Dependencies

- Updated @lde/pipeline to 0.31.3

## 0.5.2 (2026-06-25)

### 🧱 Updated Dependencies

- Updated @lde/pipeline to 0.31.2

## 0.5.1 (2026-06-25)

### 🧱 Updated Dependencies

- Updated @lde/pipeline to 0.31.1

## 0.5.0 (2026-06-22)

### 🧱 Updated Dependencies

- Updated @lde/pipeline to 0.31.0

## 0.4.23 (2026-06-19)

### 🧱 Updated Dependencies

- Updated @lde/pipeline to 0.30.22

## 0.4.22 (2026-06-18)

### 🧱 Updated Dependencies

- Updated @lde/pipeline to 0.30.21

## 0.4.21 (2026-06-18)

### 🧱 Updated Dependencies

- Updated @lde/pipeline to 0.30.20

## 0.4.20 (2026-06-17)

### 🧱 Updated Dependencies

- Updated @lde/pipeline to 0.30.19

## 0.4.19 (2026-06-17)

### 🧱 Updated Dependencies

- Updated @lde/pipeline to 0.30.18

## 0.4.18 (2026-06-17)

### 🧱 Updated Dependencies

- Updated @lde/pipeline to 0.30.17

## 0.4.17 (2026-06-16)

### 🧱 Updated Dependencies

- Updated @lde/pipeline to 0.30.16

## 0.4.16 (2026-06-15)

### 🧱 Updated Dependencies

- Updated @lde/pipeline to 0.30.15

## 0.4.15 (2026-06-15)

### 🧱 Updated Dependencies

- Updated @lde/pipeline to 0.30.14
- Updated @lde/dataset to 0.7.7

## 0.4.14 (2026-06-15)

### 🧱 Updated Dependencies

- Updated @lde/pipeline to 0.30.13
- Updated @lde/dataset to 0.7.6

## 0.4.13 (2026-06-11)

### 🧱 Updated Dependencies

- Updated @lde/pipeline to 0.30.12

## 0.4.12 (2026-06-11)

### 🚀 Features

- **pipeline-shacl-sampler:** add excludeResources hook to subtract resources from samples ([#453](https://github.com/ldelements/lde/pull/453))

## 0.4.11 (2026-06-11)

### 🧱 Updated Dependencies

- Updated @lde/pipeline to 0.30.11

## 0.4.10 (2026-06-10)

### 🧱 Updated Dependencies

- Updated @lde/pipeline to 0.30.10

## 0.4.9 (2026-06-10)

### 🧱 Updated Dependencies

- Updated @lde/pipeline to 0.30.9
- Updated @lde/dataset to 0.7.5

## 0.4.8 (2026-06-10)

### 🧱 Updated Dependencies

- Updated @lde/pipeline to 0.30.8

## 0.4.7 (2026-06-08)

### 🧱 Updated Dependencies

- Updated @lde/pipeline to 0.30.7

## 0.4.6 (2026-06-08)

### 🧱 Updated Dependencies

- Updated @lde/pipeline to 0.30.6

## 0.4.5 (2026-06-08)

### 🧱 Updated Dependencies

- Updated @lde/pipeline to 0.30.5

## 0.4.4 (2026-06-01)

### 🧱 Updated Dependencies

- Updated @lde/pipeline to 0.30.4

## 0.4.3 (2026-05-28)

### 🚀 Features

- **pipeline:** adaptive per-endpoint SPARQL timeouts ([#421](https://github.com/ldelements/lde/pull/421), [#419](https://github.com/ldelements/lde/issues/419))

### 🧱 Updated Dependencies

- Updated @lde/pipeline to 0.30.3

## 0.4.2 (2026-05-27)

### 🧱 Updated Dependencies

- Updated @lde/pipeline to 0.30.2

## 0.4.1 (2026-05-27)

### 🧱 Updated Dependencies

- Updated @lde/pipeline to 0.30.1

## 0.4.0 (2026-05-27)

### 🚀 Features

- ⚠️  **pipeline-shacl-validator:** composable reportWriters in place of reportDir ([#408](https://github.com/ldelements/lde/pull/408))

### ⚠️  Breaking Changes

- **pipeline-shacl-validator:** composable reportWriters in place of reportDir  ([#408](https://github.com/ldelements/lde/pull/408))
  reportDir is no longer accepted and was required; pass
  `reportWriters: [new FileWriter({ outputDir: ... })]` to preserve the
  previous on-disk behaviour.
  * fix(pipeline-shacl-validator): restore ValidationResult.message and document writer ergonomics
  Address findings from a recall-biased code review of #408.
  - Restore ValidationResult.message when violations are routed to reportWriters,
    so the halt-mode error in Stage.validateBuffer (stage.ts:302) still points at
    the report destination instead of degrading to a context-free count.
  - README: actionable guidance for SparqlUpdateWriter named graphs (no per-call
    override exists, so route to a separate endpoint or wrap the writer).
  - README: warn about FileWriter filesystem collisions when main writer and
    report writer share outputDir; the old .validation.<ext> infix prevented this
    implicitly, the new ergonomics do not.
  - README: flag that an empty reportWriters default silently discards violation
    detail, so the trade-off is deliberate rather than surprising.

### 🧱 Updated Dependencies

- Updated @lde/pipeline to 0.30.0

## 0.3.2 (2026-05-22)

### 🚀 Features

- **pipeline-shacl-sampler:** support namespace aliases ([#398](https://github.com/ldelements/lde/pull/398))

### 🧱 Updated Dependencies

- Updated @lde/pipeline to 0.29.2

## 0.3.1 (2026-05-21)

### 🧱 Updated Dependencies

- Updated @lde/pipeline to 0.29.1
- Updated @lde/dataset to 0.7.4

## 0.3.0 (2026-05-18)

### 🩹 Fixes

- **pipeline-shacl-sampler:** cap samples per class via maxResults ([c7c9fe8](https://github.com/ldelements/lde/commit/c7c9fe8))

### 🧱 Updated Dependencies

- Updated @lde/pipeline to 0.29.0

## 0.2.0 (2026-05-15)

### 🚀 Features

- **pipeline-shacl-sampler:** add per-class sampling stages derived from SHACL ([#381](https://github.com/ldelements/lde/pull/381))

### 🧱 Updated Dependencies

- Updated @lde/pipeline to 0.28.14