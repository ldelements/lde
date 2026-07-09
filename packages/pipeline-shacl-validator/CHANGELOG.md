## 0.16.0 (2026-07-09)

### 🧱 Updated Dependencies

- Updated @lde/pipeline to 0.34.0

## 0.15.4 (2026-07-08)

### 🧱 Updated Dependencies

- Updated @lde/pipeline to 0.33.4

## 0.15.3 (2026-07-08)

### 🧱 Updated Dependencies

- Updated @lde/pipeline to 0.33.3

## 0.15.2 (2026-07-08)

### 🧱 Updated Dependencies

- Updated @lde/pipeline to 0.33.2

## 0.15.1 (2026-07-08)

### 🧱 Updated Dependencies

- Updated @lde/pipeline to 0.33.1

## 0.15.0 (2026-07-08)

### 🚀 Features

- ⚠️  **search-typesense:** BlueGreenRebuild and InPlaceRebuild writers ([#560](https://github.com/ldelements/lde/pull/560))

### ⚠️  Breaking Changes

- **search-typesense:** BlueGreenRebuild and InPlaceRebuild writers  ([#560](https://github.com/ldelements/lde/pull/560))
  RunWriter.flush takes a second DatasetOutcome argument.
  Implementations that ignore it are unaffected; direct callers pass one.
  * feat(search-typesense)!: replace rebuild() with transactional writers
  The one-shot rebuild() becomes two @lde/pipeline Writer implementations,
  one per update mode, so a Pipeline drives indexing without branching on
  the mode (see docs/decisions/0006):
  - BlueGreenRebuild: openRun takes the single-flight cross-pod lock and
    creates a fresh versioned collection; write streams documents into it,
    batched across write calls; commit atomically repoints the alias,
    drops the superseded collection and releases the lock; abort drops the
    half-built collection. Deletion is implicit.
  - InPlaceRebuild (new): per-source upsert into one long-lived collection,
    each document stamped with source and last_seen. A successful dataset
    flush sweeps the source’s documents the run did not rewrite (a failed
    dataset is not swept – the next successful run reconciles); commit
    sweeps sources that left the run’s selection and releases the lock;
    abort only releases the lock.
  The pure sweep planning (departed sources, stale/source filters) is
  exported for reuse; the membership sweep throws beyond the 10 000-source
  facet cap rather than sweeping blind. A run opened while another holds
  the lock throws RebuildAlreadyRunning instead of returning null.
  BREAKING CHANGE: rebuild() and RebuildOptions are gone; construct a
  BlueGreenRebuild (options unchanged) and drive it via openRun →
  write → commit, or let an @lde/pipeline Pipeline do so. @lde/pipeline
  and @lde/dataset are now peerDependencies.
  * refactor(search-typesense): deduplicate the rebuild writers’ plumbing
  Review cleanups on the rebuild writers:
  - The lock choreography lives once: openLockedRun acquires the
    single-flight lock, runs the writer-specific setup, and releases the
    lock again when the setup fails – both writers now contain only their
    genuinely different bodies. The shared import batch default moves next
    to BatchImporter.
  - acquireLock takes the lock in a single request on the happy path,
    creating the lock collection only on the first-ever 404, via a shared
    ensureCollectionExists that both the lock and the In-place collection
    use (giving the latter concurrent-creator tolerance for free).
  - sweep.ts owns the source/last_seen bookkeeping names, so stamping and
    sweeping can never disagree, and quotes filter values with the
    query compiler’s escapeFilterValue instead of a second quoting policy
    that threw on backticks.
  - The membership sweep deletes departed sources in combined, length-
    budgeted filters (membershipSweepFilters) instead of one round-trip
    per source.
  - The rebuild specs share one test/helpers.ts (run contexts, document
    streams, Typesense errors, lock seeding) instead of four copies.
  * build(search-typesense): align peer range and lockfile with the release
  main released @lde/pipeline 0.32.0 (and rewrote dependent peer ranges)
  after this branch declared its ^0.31.4 peer, so npm ci failed with
  ERESOLVE. The peer range now tracks the released major-equivalent and
  the lockfile is regenerated from main’s.
  * docs(search-typesense): gloss the Blue/green and In-place rebuild patterns
  Keep the shared ubiquitous language (the NDE Stack pattern names, matched
  1:1 in code and docs) but expand each term inline the first time it
  appears, so a reader without deployment background gets the mechanism
  without a rename: Blue/green = build fresh then swap atomically, In-place
  = update the live index directly. Links to the Stack patterns page.
  * fix(search-typesense): correct the membership-sweep source-cap boundary
  The cap check requested max_facet_values equal to the ceiling and threw
  on counts.length >= ceiling, so exactly N distinct sources (Typesense
  returns at most max_facet_values) tripped a false truncation error, and
  an index that genuinely grew past the ceiling threw on every commit –
  the sweep never ran, the source count never dropped, and the index
  wedged permanently.
  Now request ceiling + 1 and throw only on > ceiling, so a full-but-not-
  truncated facet proceeds and only a real overflow refuses. The ceiling
  is exposed as InPlaceRebuildOptions.maxSweepableSources (default 10 000)
  so an operator can raise it ahead of the wall instead of redeploying.
  * fix(pipeline): roll back opened writers when a fan-out sibling’s openRun fails
  FanOutWriter.openRun awaited all writers with Promise.all and the
  pipeline opens the run outside its try, so if one writer opened (taking
  a cross-pod lock, creating a collection) and a sibling’s openRun then
  rejected, the pipeline threw before it had a run to abort – leaking the
  opened writer’s lock and collection. openRun now settles all writers,
  aborts the ones that opened, and rethrows the first failure.
  * fix(search-typesense): roll back a failed dataset from both rebuild writers
  The rebuild writers implemented no reset and Blue/green consulted no
  per-dataset outcome, so the pipeline's dump-fallback discard was a
  no-op and a dataset that failed after streaming documents left them in
  the index: Blue/green shipped them at the swap, In-place kept them
  stamped with the current runId where the success sweep could not reach.
  Both writers now stamp each document with its source (dataset IRI) and
  roll a dataset out on reset / a failed flush, streaming — no buffering,
  so it scales to object volumes:
  - Blue/green deletes the dataset's documents from the not-yet-live
    collection (source = dataset); a failed dataset contributes nothing to
    the swap.
  - In-place deletes only this run's writes for the source
    (source = dataset && last_seen = runId) on reset, leaving prior-run
    documents for the success sweep to reconcile; a failed flush still
    leaves them for the next run.
  The shared bookkeeping (SOURCE_FIELD stamping, deleteByFilter, options
  resolution, reserved-field guard) moves to rebuild-support.ts so both
  writers single-source it.
  * test(pipeline): lower coverage floor for the fan-out openRun rollback branch"
  M	docs/decisions/0006-make-the-writer-transaction-aware.md
  M	package-lock.json
  M	packages/pipeline-shacl-validator/src/shacl-validator.ts
  M	packages/pipeline-shacl-validator/test/shacl-validator.test.ts
  M	packages/pipeline/README.md
  M	packages/pipeline/src/pipeline.ts
  M	packages/pipeline/src/writer/fileWriter.ts
  M	packages/pipeline/src/writer/writer.ts
  M	packages/pipeline/test/pipeline.test.ts
  M	packages/pipeline/vite.config.ts
  M	packages/search-typesense/README.md
  M	packages/search-typesense/package.json
  D	packages/search-typesense/src/adapter.ts
  A	packages/search-typesense/src/blue-green-rebuild.ts
  A	packages/search-typesense/src/import.ts
  A	packages/search-typesense/src/in-place-rebuild.ts
  M	packages/search-typesense/src/index.ts
  A	packages/search-typesense/src/lock.ts
  A	packages/search-typesense/src/rebuild-support.ts
  A	packages/search-typesense/src/sweep.ts
  D	packages/search-typesense/test/adapter.test.ts
  A	packages/search-typesense/test/blue-green-rebuild.test.ts
  A	packages/search-typesense/test/helpers.ts
  A	packages/search-typesense/test/in-place-rebuild.test.ts
  A	packages/search-typesense/test/lock.test.ts
  A	packages/search-typesense/test/rebuild-error-paths.test.ts
  A	packages/search-typesense/test/rebuild-support.test.ts
  A	packages/search-typesense/test/sweep.test.ts
  M	packages/search-typesense/tsconfig.lib.json
  M	packages/search-typesense/vite.config.ts

### 🧱 Updated Dependencies

- Updated @lde/pipeline to 0.33.0

## 0.14.1 (2026-07-08)

### 🚀 Features

- **pipeline-shacl-validator:** add conformanceDisallows severity set ([#564](https://github.com/ldelements/lde/pull/564))

## 0.14.0 (2026-07-07)

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

## 0.13.5 (2026-06-26)

### 🧱 Updated Dependencies

- Updated @lde/pipeline to 0.31.5
- Updated @lde/dataset to 0.7.8

## 0.13.4 (2026-06-26)

### 🧱 Updated Dependencies

- Updated @lde/pipeline to 0.31.4

## 0.13.3 (2026-06-25)

### 🧱 Updated Dependencies

- Updated @lde/pipeline to 0.31.3

## 0.13.2 (2026-06-25)

### 🧱 Updated Dependencies

- Updated @lde/pipeline to 0.31.2

## 0.13.1 (2026-06-25)

### 🧱 Updated Dependencies

- Updated @lde/pipeline to 0.31.1

## 0.13.0 (2026-06-22)

### 🧱 Updated Dependencies

- Updated @lde/pipeline to 0.31.0

## 0.12.23 (2026-06-19)

### 🧱 Updated Dependencies

- Updated @lde/pipeline to 0.30.22

## 0.12.22 (2026-06-18)

### 🧱 Updated Dependencies

- Updated @lde/pipeline to 0.30.21

## 0.12.21 (2026-06-18)

### 🧱 Updated Dependencies

- Updated @lde/pipeline to 0.30.20

## 0.12.20 (2026-06-17)

### 🧱 Updated Dependencies

- Updated @lde/pipeline to 0.30.19

## 0.12.19 (2026-06-17)

### 🧱 Updated Dependencies

- Updated @lde/pipeline to 0.30.18

## 0.12.18 (2026-06-17)

### 🩹 Fixes

- **pipeline-shacl-validator:** skolemise validation report blank nodes ([#480](https://github.com/ldelements/lde/pull/480))

## 0.12.17 (2026-06-17)

### 🧱 Updated Dependencies

- Updated @lde/pipeline to 0.30.17

## 0.12.16 (2026-06-16)

### 🧱 Updated Dependencies

- Updated @lde/pipeline to 0.30.16

## 0.12.15 (2026-06-15)

### 🧱 Updated Dependencies

- Updated @lde/pipeline to 0.30.15

## 0.12.14 (2026-06-15)

### 🧱 Updated Dependencies

- Updated @lde/pipeline to 0.30.14
- Updated @lde/dataset to 0.7.7

## 0.12.13 (2026-06-15)

### 🧱 Updated Dependencies

- Updated @lde/pipeline to 0.30.13
- Updated @lde/dataset to 0.7.6

## 0.12.12 (2026-06-11)

### 🧱 Updated Dependencies

- Updated @lde/pipeline to 0.30.12

## 0.12.11 (2026-06-11)

### 🧱 Updated Dependencies

- Updated @lde/pipeline to 0.30.11

## 0.12.10 (2026-06-10)

### 🧱 Updated Dependencies

- Updated @lde/pipeline to 0.30.10

## 0.12.9 (2026-06-10)

### 🧱 Updated Dependencies

- Updated @lde/pipeline to 0.30.9
- Updated @lde/dataset to 0.7.5

## 0.12.8 (2026-06-10)

### 🧱 Updated Dependencies

- Updated @lde/pipeline to 0.30.8

## 0.12.7 (2026-06-08)

### 🧱 Updated Dependencies

- Updated @lde/pipeline to 0.30.7

## 0.12.6 (2026-06-08)

### 🧱 Updated Dependencies

- Updated @lde/pipeline to 0.30.6

## 0.12.5 (2026-06-08)

### 🧱 Updated Dependencies

- Updated @lde/pipeline to 0.30.5

## 0.12.4 (2026-06-01)

### 🧱 Updated Dependencies

- Updated @lde/pipeline to 0.30.4

## 0.12.3 (2026-05-28)

### 🧱 Updated Dependencies

- Updated @lde/pipeline to 0.30.3

## 0.12.2 (2026-05-27)

### 🧱 Updated Dependencies

- Updated @lde/pipeline to 0.30.2

## 0.12.1 (2026-05-27)

### 🚀 Features

- **pipeline:** add graphIri option to SparqlUpdateWriter ([#409](https://github.com/ldelements/lde/pull/409))

### 🧱 Updated Dependencies

- Updated @lde/pipeline to 0.30.1

## 0.12.0 (2026-05-27)

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

## 0.11.2 (2026-05-22)

### 🧱 Updated Dependencies

- Updated @lde/pipeline to 0.29.2

## 0.11.1 (2026-05-21)

### 🧱 Updated Dependencies

- Updated @lde/pipeline to 0.29.1
- Updated @lde/dataset to 0.7.4

## 0.11.0 (2026-05-18)

### 🧱 Updated Dependencies

- Updated @lde/pipeline to 0.29.0

## 0.10.14 (2026-05-15)

### 🧱 Updated Dependencies

- Updated @lde/pipeline to 0.28.14

## 0.10.13 (2026-04-28)

### 🧱 Updated Dependencies

- Updated @lde/pipeline to 0.28.13

## 0.10.12 (2026-04-28)

### 🧱 Updated Dependencies

- Updated @lde/pipeline to 0.28.12

## 0.10.11 (2026-04-23)

### 🧱 Updated Dependencies

- Updated @lde/pipeline to 0.28.11
- Updated @lde/dataset to 0.7.3

## 0.10.10 (2026-04-23)

### 🧱 Updated Dependencies

- Updated @lde/pipeline to 0.28.10

## 0.10.9 (2026-04-17)

### 🧱 Updated Dependencies

- Updated @lde/pipeline to 0.28.9

## 0.10.8 (2026-04-15)

### 🧱 Updated Dependencies

- Updated @lde/pipeline to 0.28.8

## 0.10.7 (2026-04-09)

### 🧱 Updated Dependencies

- Updated @lde/pipeline to 0.28.7

## 0.10.6 (2026-04-06)

### 🧱 Updated Dependencies

- Updated @lde/pipeline to 0.28.6

## 0.10.5 (2026-03-24)

### 🧱 Updated Dependencies

- Updated @lde/pipeline to 0.28.5

## 0.10.4 (2026-03-24)

### 🧱 Updated Dependencies

- Updated @lde/pipeline to 0.28.4

## 0.10.3 (2026-03-24)

### 🧱 Updated Dependencies

- Updated @lde/pipeline to 0.28.3

## 0.10.2 (2026-03-23)

### 🧱 Updated Dependencies

- Updated @lde/pipeline to 0.28.2

## 0.10.1 (2026-03-23)

### 🧱 Updated Dependencies

- Updated @lde/pipeline to 0.28.1

## 0.10.0 (2026-03-22)

### 🧱 Updated Dependencies

- Updated @lde/pipeline to 0.28.0

## 0.9.0 (2026-03-20)

### 🧱 Updated Dependencies

- Updated @lde/pipeline to 0.27.0

## 0.8.0 (2026-03-19)

### 🧱 Updated Dependencies

- Updated @lde/pipeline to 0.26.0

## 0.7.3 (2026-03-19)

### 🧱 Updated Dependencies

- Updated @lde/pipeline to 0.25.3

## 0.7.2 (2026-03-19)

### 🧱 Updated Dependencies

- Updated @lde/pipeline to 0.25.2

## 0.7.1 (2026-03-19)

### 🧱 Updated Dependencies

- Updated @lde/pipeline to 0.25.1

## 0.7.0 (2026-03-18)

### 🧱 Updated Dependencies

- Updated @lde/pipeline to 0.25.0

## 0.6.5 (2026-03-16)

### 🩹 Fixes

- **pipeline-shacl-validator:** truncate report file at start of each run ([#251](https://github.com/ldelements/lde/pull/251))

### ❤️ Thank You

- David de Boer @ddeboer

## 0.6.4 (2026-03-16)

### 🧱 Updated Dependencies

- Updated @lde/pipeline to 0.24.4
- Updated @lde/dataset to 0.7.2

## 0.6.3 (2026-03-16)

### 🧱 Updated Dependencies

- Updated @lde/pipeline to 0.24.3

## 0.6.2 (2026-03-16)

### 🧱 Updated Dependencies

- Updated @lde/pipeline to 0.24.2

## 0.6.1 (2026-03-16)

### 🧱 Updated Dependencies

- Updated @lde/pipeline to 0.24.1

## 0.6.0 (2026-03-13)

### 🧱 Updated Dependencies

- Updated @lde/pipeline to 0.24.0

## 0.5.0 (2026-03-13)

### 🧱 Updated Dependencies

- Updated @lde/pipeline to 0.23.0

## 0.4.1 (2026-03-13)

### 🧱 Updated Dependencies

- Updated @lde/pipeline to 0.22.1

## 0.4.0 (2026-03-13)

### 🧱 Updated Dependencies

- Updated @lde/pipeline to 0.22.0

## 0.3.0 (2026-03-12)

### 🧱 Updated Dependencies

- Updated @lde/pipeline to 0.21.0

## 0.2.0 (2026-03-09)

### 🚀 Features

- **pipeline:** add SHACL validation as a stage option ([#218](https://github.com/ldelements/lde/pull/218))

### 🧱 Updated Dependencies

- Updated @lde/pipeline to 0.20.0

### ❤️ Thank You

- David de Boer