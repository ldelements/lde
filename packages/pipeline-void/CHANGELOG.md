## 0.32.4 (2026-07-23)

### 🧱 Updated Dependencies

- Updated @lde/pipeline to 0.34.4

## 0.32.3 (2026-07-23)

### 🧱 Updated Dependencies

- Updated @lde/pipeline to 0.34.3

## 0.32.2 (2026-07-17)

### 🧱 Updated Dependencies

- Updated @lde/pipeline to 0.34.2

## 0.32.1 (2026-07-12)

### 🧱 Updated Dependencies

- Updated @lde/pipeline to 0.34.1

## 0.32.0 (2026-07-09)

### 🚀 Features

- ⚠️  **pipeline:** add beforeDatasetWrite hook; split namespace normalization ([#577](https://github.com/ldelements/lde/pull/577), [#334](https://github.com/ldelements/lde/issues/334))

### ⚠️  Breaking Changes

- **pipeline:** add beforeDatasetWrite hook; split namespace normalization  ([#577](https://github.com/ldelements/lde/pull/577), [#334](https://github.com/ldelements/lde/issues/334))
  @lde/pipeline no longer exports schemaOrgNormalizationPlugin
  or namespaceNormalizationPlugin; use schemaOrgNormalizationPlugin from
  @lde/pipeline-void. @lde/pipeline-void's voidStages no longer accepts
  namespaceAliases; add schemaOrgNormalizationPlugin to the pipeline plugins
  instead.
  * refactor(pipeline)!: keep a generic namespace-rewrite plugin, merge stays in pipeline-void
  Split schema.org namespace handling by generality instead of removing the
  generic capability, so a non-VoID consumer (e.g. mapping instance data to an
  application profile) can still normalize a namespace.
  - @lde/pipeline keeps namespaceNormalizationPlugin / schemaOrgNormalizationPlugin,
    now a blanket, vocabulary-agnostic beforeStageWrite rewrite of a namespace’s
    IRIs in every term position (previously only void:class/void:property objects,
    and only in this package before this PR removed them).
  - @lde/pipeline-void renames its beforeDatasetWrite merge to
    schemaOrgPartitionMergePlugin / namespacePartitionMergePlugin, so a VoID
    consumer can’t pick the plain rewrite and leave the duplicate partition nodes
    (#334) unmerged.
  - Both share the canonicalizeIri primitive; the merge keeps its own selective
    canonicalization (leaves void:vocabulary and entity-properties in the source
    namespace), which the blanket rewrite deliberately does not.
  Docs: renumber the ADR to 7 and make it self-contained; document the split in
  the ADR and both package READMEs.
  BREAKING CHANGE: @lde/pipeline’s namespaceNormalizationPlugin and
  schemaOrgNormalizationPlugin now rewrite every matching IRI in any term position
  via beforeStageWrite, not just void:class/void:property objects. The VoID
  partition merge is now schemaOrgPartitionMergePlugin / namespacePartitionMergePlugin
  in @lde/pipeline-void.
  Claude-Session: https://claude.ai/code/session_01H8MVbsXSoNbYREYMFLy6Eg"
  D	docs/decisions/0007-merge-namespace-alias-partitions.md
  A	docs/decisions/0007-namespace-merge-as-a-dataset-plugin.md
  M	packages/pipeline-void/README.md
  M	packages/pipeline-void/queries/class-partition.rq
  M	packages/pipeline-void/queries/class-properties-objects.rq
  M	packages/pipeline-void/queries/class-properties-subjects.rq
  M	packages/pipeline-void/queries/class-property-datatypes.rq
  M	packages/pipeline-void/queries/class-property-languages.rq
  M	packages/pipeline-void/queries/class-property-object-classes.rq
  M	packages/pipeline-void/src/index.ts
  D	packages/pipeline-void/src/namespaceAliases.ts
  A	packages/pipeline-void/src/partitionIri.ts
  M	packages/pipeline-void/src/partitionMerge.ts
  M	packages/pipeline-void/src/stage.ts
  D	packages/pipeline-void/test/namespaceAliases.test.ts
  M	packages/pipeline-void/test/namespaceNormalization.integration.test.ts
  A	packages/pipeline-void/test/partitionIri.test.ts
  M	packages/pipeline-void/test/partitionMerge.test.ts
  M	packages/pipeline-void/vite.config.ts
  M	packages/pipeline/README.md
  M	packages/pipeline/src/index.ts
  M	packages/pipeline/src/pipeline.ts
  M	packages/pipeline/src/plugin/namespaceNormalization.ts
  M	packages/pipeline/src/plugin/schemaOrgNormalization.ts
  M	packages/pipeline/test/pipeline.test.ts
  M	packages/pipeline/test/plugin/namespaceNormalization.test.ts
  M	packages/pipeline/test/plugin/schemaOrgNormalization.test.ts
  M	packages/pipeline/vite.config.ts

### 🧱 Updated Dependencies

- Updated @lde/pipeline to 0.34.0

## 0.31.4 (2026-07-08)

### 🚀 Features

- **pipeline-void:** merge namespace-alias variants into one VoID partition ([#568](https://github.com/ldelements/lde/pull/568), [#334](https://github.com/ldelements/lde/issues/334))

### 🧱 Updated Dependencies

- Updated @lde/pipeline to 0.33.4

## 0.31.3 (2026-07-08)

### 🧱 Updated Dependencies

- Updated @lde/pipeline to 0.33.3

## 0.31.2 (2026-07-08)

### 🧱 Updated Dependencies

- Updated @lde/pipeline to 0.33.2

## 0.31.1 (2026-07-08)

### 🧱 Updated Dependencies

- Updated @lde/pipeline to 0.33.1

## 0.31.0 (2026-07-08)

### 🧱 Updated Dependencies

- Updated @lde/pipeline to 0.33.0

## 0.30.0 (2026-07-07)

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

## 0.29.5 (2026-06-26)

### 🧱 Updated Dependencies

- Updated @lde/pipeline to 0.31.5
- Updated @lde/dataset to 0.7.8

## 0.29.4 (2026-06-26)

### 🧱 Updated Dependencies

- Updated @lde/pipeline to 0.31.4

## 0.29.3 (2026-06-25)

### 🧱 Updated Dependencies

- Updated @lde/pipeline to 0.31.3

## 0.29.2 (2026-06-25)

### 🚀 Features

- **pipeline:** add expectsOutput to fail a stage that yields no quads ([#515](https://github.com/ldelements/lde/pull/515))

### 🧱 Updated Dependencies

- Updated @lde/pipeline to 0.31.2

## 0.29.1 (2026-06-25)

### 🧱 Updated Dependencies

- Updated @lde/pipeline to 0.31.1

## 0.29.0 (2026-06-22)

### 🧱 Updated Dependencies

- Updated @lde/pipeline to 0.31.0

## 0.28.22 (2026-06-19)

### 🧱 Updated Dependencies

- Updated @lde/pipeline to 0.30.22

## 0.28.21 (2026-06-18)

### 🧱 Updated Dependencies

- Updated @lde/pipeline to 0.30.21

## 0.28.20 (2026-06-18)

### 🧱 Updated Dependencies

- Updated @lde/pipeline to 0.30.20

## 0.28.19 (2026-06-17)

### 🧱 Updated Dependencies

- Updated @lde/pipeline to 0.30.19

## 0.28.18 (2026-06-17)

### 🧱 Updated Dependencies

- Updated @lde/pipeline to 0.30.18

## 0.28.17 (2026-06-17)

### 🧱 Updated Dependencies

- Updated @lde/pipeline to 0.30.17

## 0.28.16 (2026-06-16)

### 🧱 Updated Dependencies

- Updated @lde/pipeline to 0.30.16

## 0.28.15 (2026-06-15)

### 🚀 Features

- **pipeline:** blank-node guard + regression assertions for cat-built indexes ([#477](https://github.com/ldelements/lde/pull/477), [#474](https://github.com/ldelements/lde/issues/474), [#352](https://github.com/ldelements/lde/issues/352))

### 🧱 Updated Dependencies

- Updated @lde/pipeline to 0.30.15

## 0.28.14 (2026-06-15)

### 🩹 Fixes

- skolemize structural nodes to prevent blank-node collisions in merged graphs ([#471](https://github.com/ldelements/lde/pull/471), [#352](https://github.com/ldelements/lde/issues/352), [#474](https://github.com/ldelements/lde/issues/474))

### 🧱 Updated Dependencies

- Updated @lde/pipeline to 0.30.14
- Updated @lde/dataset to 0.7.7

## 0.28.13 (2026-06-15)

### 🧱 Updated Dependencies

- Updated @lde/pipeline to 0.30.13
- Updated @lde/dataset to 0.7.6

## 0.28.12 (2026-06-11)

### 🧱 Updated Dependencies

- Updated @lde/pipeline to 0.30.12

## 0.28.11 (2026-06-11)

### 🧱 Updated Dependencies

- Updated @lde/pipeline to 0.30.11

## 0.28.10 (2026-06-10)

### 🧱 Updated Dependencies

- Updated @lde/pipeline to 0.30.10

## 0.28.9 (2026-06-10)

### 🧱 Updated Dependencies

- Updated @lde/pipeline to 0.30.9
- Updated @lde/dataset to 0.7.5

## 0.28.8 (2026-06-10)

### 🧱 Updated Dependencies

- Updated @lde/pipeline to 0.30.8

## 0.28.7 (2026-06-08)

### 🧱 Updated Dependencies

- Updated @lde/pipeline to 0.30.7

## 0.28.6 (2026-06-08)

### 🧱 Updated Dependencies

- Updated @lde/pipeline to 0.30.6

## 0.28.5 (2026-06-08)

### 🚀 Features

- make VoID stage executors wrappable with quad transforms ([#438](https://github.com/ldelements/lde/pull/438))

### 🧱 Updated Dependencies

- Updated @lde/pipeline to 0.30.5

## 0.28.4 (2026-06-01)

### 🧱 Updated Dependencies

- Updated @lde/pipeline to 0.30.4

## 0.28.3 (2026-05-28)

### 🚀 Features

- **pipeline:** adaptive per-endpoint SPARQL timeouts ([#421](https://github.com/ldelements/lde/pull/421), [#419](https://github.com/ldelements/lde/issues/419))

### 🧱 Updated Dependencies

- Updated @lde/pipeline to 0.30.3

## 0.28.2 (2026-05-27)

### 🧱 Updated Dependencies

- Updated @lde/pipeline to 0.30.2

## 0.28.1 (2026-05-27)

### 🧱 Updated Dependencies

- Updated @lde/pipeline to 0.30.1

## 0.28.0 (2026-05-27)

### 🧱 Updated Dependencies

- Updated @lde/pipeline to 0.30.0

## 0.27.2 (2026-05-22)

### 🧱 Updated Dependencies

- Updated @lde/pipeline to 0.29.2

## 0.27.1 (2026-05-21)

### 🧱 Updated Dependencies

- Updated @lde/pipeline to 0.29.1
- Updated @lde/dataset to 0.7.4

## 0.27.0 (2026-05-18)

### 🧱 Updated Dependencies

- Updated @lde/pipeline to 0.29.0

## 0.26.15 (2026-05-15)

### 🧱 Updated Dependencies

- Updated @lde/pipeline to 0.28.14

## 0.26.14 (2026-04-28)

### 🧱 Updated Dependencies

- Updated @lde/pipeline to 0.28.13

## 0.26.13 (2026-04-28)

### 🧱 Updated Dependencies

- Updated @lde/pipeline to 0.28.12

## 0.26.12 (2026-04-23)

### 🧱 Updated Dependencies

- Updated @lde/pipeline to 0.28.11
- Updated @lde/dataset to 0.7.3

## 0.26.11 (2026-04-23)

### 🧱 Updated Dependencies

- Updated @lde/pipeline to 0.28.10

## 0.26.10 (2026-04-17)

### 🧱 Updated Dependencies

- Updated @lde/pipeline to 0.28.9

## 0.26.9 (2026-04-15)

### 🧱 Updated Dependencies

- Updated @lde/pipeline to 0.28.8

## 0.26.8 (2026-04-09)

### 🧱 Updated Dependencies

- Updated @lde/pipeline to 0.28.7

## 0.26.7 (2026-04-06)

### 🧱 Updated Dependencies

- Updated @lde/pipeline to 0.28.6

## 0.26.6 (2026-04-01)

### 🚀 Features

- **pipeline-void:** allow passing additional vocabularies to detectVocabularies and voidStages ([#328](https://github.com/ldelements/lde/pull/328))

## 0.26.5 (2026-03-24)

### 🧱 Updated Dependencies

- Updated @lde/pipeline to 0.28.5

## 0.26.4 (2026-03-24)

### 🧱 Updated Dependencies

- Updated @lde/pipeline to 0.28.4

## 0.26.3 (2026-03-24)

### 🧱 Updated Dependencies

- Updated @lde/pipeline to 0.28.3

## 0.26.2 (2026-03-23)

### 🧱 Updated Dependencies

- Updated @lde/pipeline to 0.28.2

## 0.26.1 (2026-03-23)

### 🚀 Features

- **pipeline:** use batchSize as selector page size ([#301](https://github.com/ldelements/lde/pull/301))

### 🧱 Updated Dependencies

- Updated @lde/pipeline to 0.28.1

### ❤️ Thank You

- David de Boer @ddeboer

## 0.26.0 (2026-03-22)

### 🧱 Updated Dependencies

- Updated @lde/pipeline to 0.28.0

## 0.25.1 (2026-03-20)

### 🩹 Fixes

- **pipeline-void:** update UriSpaceExecutor JSDoc to reflect target dataset IRI behaviour ([#282](https://github.com/ldelements/lde/pull/282))

### ❤️ Thank You

- David de Boer @ddeboer

## 0.25.0 (2026-03-20)

### 🧱 Updated Dependencies

- Updated @lde/pipeline to 0.27.0

## 0.24.0 (2026-03-19)

### 🧱 Updated Dependencies

- Updated @lde/pipeline to 0.26.0

## 0.23.3 (2026-03-19)

### 🧱 Updated Dependencies

- Updated @lde/pipeline to 0.25.3

## 0.23.2 (2026-03-19)

### 🧱 Updated Dependencies

- Updated @lde/pipeline to 0.25.2

## 0.23.1 (2026-03-19)

### 🧱 Updated Dependencies

- Updated @lde/pipeline to 0.25.1

## 0.23.0 (2026-03-18)

### 🧱 Updated Dependencies

- Updated @lde/pipeline to 0.25.0

## 0.22.4 (2026-03-16)

### 🩹 Fixes

- **dataset:** guard SPARQL IRI interpolation against injection ([99933a7](https://github.com/ldelements/lde/commit/99933a7))

### 🧱 Updated Dependencies

- Updated @lde/pipeline to 0.24.4
- Updated @lde/dataset to 0.7.2

### ❤️ Thank You

- David de Boer @ddeboer

## 0.22.3 (2026-03-16)

### 🧱 Updated Dependencies

- Updated @lde/pipeline to 0.24.3

## 0.22.2 (2026-03-16)

### 🧱 Updated Dependencies

- Updated @lde/pipeline to 0.24.2

## 0.22.1 (2026-03-16)

### 🧱 Updated Dependencies

- Updated @lde/pipeline to 0.24.1

## 0.22.0 (2026-03-13)

### 🧱 Updated Dependencies

- Updated @lde/pipeline to 0.24.0

## 0.21.0 (2026-03-13)

### 🚀 Features

- **pipeline-void:** add timeout and perClass toggle to VoID stage options ([#236](https://github.com/ldelements/lde/pull/236))

### ❤️ Thank You

- David de Boer @ddeboer

## 0.20.0 (2026-03-13)

### 🚀 Features

- **pipeline:** add retry logic, perClass conversion, and tuneable concurrency ([#235](https://github.com/ldelements/lde/pull/235))

### 🧱 Updated Dependencies

- Updated @lde/pipeline to 0.23.0

### ❤️ Thank You

- David de Boer

## 0.19.1 (2026-03-13)

### 🩹 Fixes

- **pipeline:** inject VALUES into innermost subquery for per-class queries ([#234](https://github.com/ldelements/lde/pull/234))

### 🧱 Updated Dependencies

- Updated @lde/pipeline to 0.22.1

### ❤️ Thank You

- David de Boer @ddeboer

## 0.19.0 (2026-03-13)

### 🧱 Updated Dependencies

- Updated @lde/pipeline to 0.22.0

## 0.18.0 (2026-03-12)

### 🧱 Updated Dependencies

- Updated @lde/pipeline to 0.21.0

## 0.17.0 (2026-03-09)

### 🚀 Features

- **pipeline:** add SHACL validation as a stage option ([#218](https://github.com/ldelements/lde/pull/218))

### 🧱 Updated Dependencies

- Updated @lde/pipeline to 0.20.0

### ❤️ Thank You

- David de Boer

## 0.16.0 (2026-03-08)

### 🧱 Updated Dependencies

- Updated @lde/pipeline to 0.19.0

## 0.15.0 (2026-03-07)

### 🧱 Updated Dependencies

- Updated @lde/pipeline to 0.18.0

## 0.14.1 (2026-03-06)

### 🧱 Updated Dependencies

- Updated @lde/pipeline to 0.17.1
- Updated @lde/dataset to 0.7.1

## 0.14.0 (2026-03-06)

### 🧱 Updated Dependencies

- Updated @lde/pipeline to 0.17.0

## 0.13.0 (2026-03-06)

### 🧱 Updated Dependencies

- Updated @lde/pipeline to 0.16.0

## 0.12.2 (2026-03-06)

### 🧱 Updated Dependencies

- Updated @lde/pipeline to 0.15.2

## 0.12.1 (2026-03-06)

### 🧱 Updated Dependencies

- Updated @lde/pipeline to 0.15.1

## 0.12.0 (2026-03-02)

### 🧱 Updated Dependencies

- Updated @lde/pipeline to 0.15.0

## 0.11.0 (2026-03-02)

### 🧱 Updated Dependencies

- Updated @lde/pipeline to 0.14.0

## 0.10.0 (2026-02-28)

### 🧱 Updated Dependencies

- Updated @lde/pipeline to 0.13.0

## 0.9.0 (2026-02-28)

### 🧱 Updated Dependencies

- Updated @lde/pipeline to 0.12.0

## 0.8.0 (2026-02-27)

### 🧱 Updated Dependencies

- Updated @lde/pipeline to 0.11.0
- Updated @lde/dataset to 0.7.0

## 0.7.0 (2026-02-27)

### 🧱 Updated Dependencies

- Updated @lde/pipeline to 0.10.0

## 0.6.0 (2026-02-27)

### 🧱 Updated Dependencies

- Updated @lde/pipeline to 0.9.0

## 0.5.1 (2026-02-27)

### 🧱 Updated Dependencies

- Updated @lde/pipeline to 0.8.1

## 0.5.0 (2026-02-27)

### 🧱 Updated Dependencies

- Updated @lde/pipeline to 0.8.0

## 0.4.1 (2026-02-20)

### 🧱 Updated Dependencies

- Updated @lde/pipeline to 0.7.1

## 0.4.0 (2026-02-20)

### 🚀 Features

- **pipeline-void:** shorten stage factory function names ([#135](https://github.com/ldelements/lde/pull/135))

### ❤️ Thank You

- David de Boer @ddeboer

## 0.3.1 (2026-02-18)

### 🩹 Fixes

- **pipeline-void:** resolve query files in published package ([#128](https://github.com/ldelements/lde/pull/128))

### ❤️ Thank You

- David de Boer @ddeboer

## 0.3.0 (2026-02-18)

### 🧱 Updated Dependencies

- Updated @lde/pipeline to 0.7.0

## 0.2.37 (2026-02-16)

### 🧱 Updated Dependencies

- Updated @lde/pipeline to 0.6.32
- Updated @lde/dataset to 0.6.10

## 0.2.36 (2026-02-16)

### 🧱 Updated Dependencies

- Updated @lde/pipeline to 0.6.31

## 0.2.35 (2026-02-16)

### 🚀 Features

- **pipeline-void:** add generic UriSpaceExecutor decorator ([#115](https://github.com/ldelements/lde/pull/115))

### ❤️ Thank You

- David de Boer @ddeboer

## 0.2.34 (2026-02-16)

### 🧱 Updated Dependencies

- Updated @lde/pipeline to 0.6.30

## 0.2.33 (2026-02-16)

### 🧱 Updated Dependencies

- Updated @lde/pipeline to 0.6.29

## 0.2.32 (2026-02-16)

This was a version bump only for @lde/pipeline-void to align it with other projects, there were no code changes.

## 0.2.31 (2026-02-15)

### 🚀 Features

- **pipeline-void:** use @zazuko/prefixes for vocabulary detection ([#110](https://github.com/ldelements/lde/pull/110))

### ❤️ Thank You

- David de Boer @ddeboer

## 0.2.30 (2026-02-15)

### 🧱 Updated Dependencies

- Updated @lde/pipeline to 0.6.28

## 0.2.29 (2026-02-15)

### 🧱 Updated Dependencies

- Updated @lde/pipeline to 0.6.27

## 0.2.28 (2026-02-15)

### 🚀 Features

- **pipeline:** defer #subjectFilter# substitution to runtime ([#107](https://github.com/ldelements/lde/pull/107))

### 🧱 Updated Dependencies

- Updated @lde/pipeline to 0.6.26

### ❤️ Thank You

- David de Boer @ddeboer

## 0.2.27 (2026-02-13)

### 🧱 Updated Dependencies

- Updated @lde/pipeline to 0.6.25
- Updated @lde/dataset to 0.6.9

## 0.2.26 (2026-02-13)

### 🧱 Updated Dependencies

- Updated @lde/pipeline to 0.6.24

## 0.2.25 (2026-02-12)

### 🧱 Updated Dependencies

- Updated @lde/pipeline to 0.6.23

## 0.2.24 (2026-02-12)

### 🧱 Updated Dependencies

- Updated @lde/pipeline to 0.6.22

## 0.2.23 (2026-02-12)

### 🧱 Updated Dependencies

- Updated @lde/pipeline to 0.6.21

## 0.2.22 (2026-02-12)

### 🚀 Features

- **pipeline:** integrate Writer into Stage.run() ([#87](https://github.com/ldelements/lde/pull/87))

### 🧱 Updated Dependencies

- Updated @lde/pipeline to 0.6.20

### ❤️ Thank You

- David de Boer @ddeboer

## 0.2.21 (2026-02-12)

### 🧱 Updated Dependencies

- Updated @lde/pipeline to 0.6.19

## 0.2.20 (2026-02-12)

### 🧱 Updated Dependencies

- Updated @lde/pipeline to 0.6.18

## 0.2.19 (2026-02-12)

### 🧱 Updated Dependencies

- Updated @lde/pipeline to 0.6.17

## 0.2.18 (2026-02-12)

### 🧱 Updated Dependencies

- Updated @lde/pipeline to 0.6.16

## 0.2.17 (2026-02-12)

This was a version bump only for @lde/pipeline-void to align it with other projects, there were no code changes.

## 0.2.16 (2026-02-11)

This was a version bump only for @lde/pipeline-void to align it with other projects, there were no code changes.

## 0.2.15 (2026-02-11)

### 🚀 Features

- **pipeline:** extract DistributionResolver, pass distribution explicitly ([#73](https://github.com/ldelements/lde/pull/73))

### 🧱 Updated Dependencies

- Updated @lde/pipeline to 0.6.15

### ❤️ Thank You

- David de Boer @ddeboer

## 0.2.14 (2026-02-11)

### 🧱 Updated Dependencies

- Updated @lde/pipeline to 0.6.14
- Updated @lde/dataset to 0.6.8

## 0.2.13 (2026-02-09)

### 🚀 Features

- **pipeline:** AST-based query manipulation for SparqlConstructExecutor ([#69](https://github.com/ldelements/lde/pull/69))

### 🧱 Updated Dependencies

- Updated @lde/pipeline to 0.6.13

### ❤️ Thank You

- David de Boer @ddeboer

## 0.2.12 (2026-02-09)

### 🧱 Updated Dependencies

- Updated @lde/pipeline to 0.6.12
- Updated @lde/dataset to 0.6.6

## 0.2.11 (2026-02-09)

### 🧱 Updated Dependencies

- Updated @lde/pipeline to 0.6.11

## 0.2.10 (2026-02-09)

### 🧱 Updated Dependencies

- Updated @lde/pipeline to 0.6.10
- Updated @lde/dataset to 0.6.5

## 0.2.9 (2026-02-09)

### 🧱 Updated Dependencies

- Updated @lde/pipeline to 0.6.9

## 0.2.8 (2026-02-09)

### 🧱 Updated Dependencies

- Updated @lde/pipeline to 0.6.8
- Updated @lde/dataset to 0.6.4

## 0.2.7 (2026-02-09)

### 🧱 Updated Dependencies

- Updated @lde/pipeline to 0.6.7

## 0.2.6 (2026-02-09)

### 🧱 Updated Dependencies

- Updated @lde/pipeline to 0.6.6
- Updated @lde/dataset to 0.6.3

## 0.2.5 (2026-02-09)

### 🧱 Updated Dependencies

- Updated @lde/pipeline to 0.6.5

## 0.2.4 (2026-02-09)

### 🧱 Updated Dependencies

- Updated @lde/pipeline to 0.6.4
- Updated @lde/dataset to 0.6.2

## 0.2.3 (2026-02-09)

### 🧱 Updated Dependencies

- Updated @lde/pipeline to 0.6.3

## 0.2.2 (2026-02-09)

### 🧱 Updated Dependencies

- Updated @lde/pipeline to 0.6.2
- Updated @lde/dataset to 0.6.1

## 0.2.1 (2026-02-09)

### 🧱 Updated Dependencies

- Updated @lde/pipeline to 0.6.1

## 0.2.0 (2026-02-07)

### 🚀 Features

- add pipeline-void package and extend pipeline with analyzers, writers, and SPARQL utilities ([#48](https://github.com/ldelements/lde/pull/48))

### 🧱 Updated Dependencies

- Updated @lde/pipeline to 0.6.0
- Updated @lde/dataset to 0.6.0

### ❤️ Thank You

- David de Boer @ddeboer