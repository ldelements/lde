## 0.31.2 (2026-06-25)

### 🚀 Features

- **pipeline:** add expectsOutput to fail a stage that yields no quads ([#515](https://github.com/ldelements/lde/pull/515))

## 0.31.1 (2026-06-25)

### 🚀 Features

- **pipeline:** reactively fall back to data dump when an endpoint stage fails ([#514](https://github.com/ldelements/lde/pull/514))

## 0.31.0 (2026-06-22)

### 🧱 Updated Dependencies

- Updated @lde/distribution-health to 0.2.0
- Updated @lde/distribution-probe to 0.2.0

## 0.30.22 (2026-06-19)

### 🧱 Updated Dependencies

- Updated @lde/dataset-registry-client to 0.8.4
- Updated @lde/distribution-health to 0.1.5
- Updated @lde/distribution-probe to 0.1.13

## 0.30.21 (2026-06-18)

### 🩹 Fixes

- **pipeline:** preserve reporter `this` when forwarding to combined reporters ([#491](https://github.com/ldelements/lde/pull/491))

## 0.30.20 (2026-06-18)

### 🧱 Updated Dependencies

- Updated @lde/distribution-health to 0.1.4
- Updated @lde/distribution-probe to 0.1.12

## 0.30.19 (2026-06-17)

### 🧱 Updated Dependencies

- Updated @lde/distribution-health to 0.1.3
- Updated @lde/distribution-probe to 0.1.11

## 0.30.18 (2026-06-17)

### 🚀 Features

- **pipeline:** accept multiple progress reporters ([#483](https://github.com/ldelements/lde/pull/483))

## 0.30.17 (2026-06-17)

### 🧱 Updated Dependencies

- Updated @lde/distribution-health to 0.1.2

## 0.30.16 (2026-06-16)

### 🚀 Features

- **pipeline:** surface per-distribution RDF-validity verdicts ([#476](https://github.com/ldelements/lde/pull/476), [#2103](https://github.com/ldelements/lde/issues/2103), [#469](https://github.com/ldelements/lde/issues/469))

## 0.30.15 (2026-06-15)

### 🚀 Features

- **pipeline:** blank-node guard + regression assertions for cat-built indexes ([#477](https://github.com/ldelements/lde/pull/477), [#474](https://github.com/ldelements/lde/issues/474), [#352](https://github.com/ldelements/lde/issues/352))

## 0.30.14 (2026-06-15)

### 🩹 Fixes

- skolemize structural nodes to prevent blank-node collisions in merged graphs ([#471](https://github.com/ldelements/lde/pull/471), [#352](https://github.com/ldelements/lde/issues/352), [#474](https://github.com/ldelements/lde/issues/474))

### 🧱 Updated Dependencies

- Updated @lde/dataset-registry-client to 0.8.3
- Updated @lde/distribution-probe to 0.1.10
- Updated @lde/sparql-importer to 0.6.5
- Updated @lde/dataset to 0.7.7

## 0.30.13 (2026-06-15)

### 🧱 Updated Dependencies

- Updated @lde/dataset-registry-client to 0.8.2
- Updated @lde/distribution-probe to 0.1.9
- Updated @lde/sparql-importer to 0.6.4
- Updated @lde/dataset to 0.7.6

## 0.30.12 (2026-06-11)

### 🚀 Features

- **pipeline:** skip unchanged datasets — provenance store, two-phase resolver, gate ([#454](https://github.com/ldelements/lde/pull/454))

## 0.30.11 (2026-06-11)

### 🚀 Features

- **pipeline:** add source-change fingerprint and reprocess decision ([#451](https://github.com/ldelements/lde/pull/451), [#450](https://github.com/ldelements/lde/issues/450))

## 0.30.10 (2026-06-10)

### 🚀 Features

- **pipeline:** add FileWriter graphIri option and atomic writes ([#452](https://github.com/ldelements/lde/pull/452))

## 0.30.9 (2026-06-10)

### 🧱 Updated Dependencies

- Updated @lde/dataset-registry-client to 0.8.1
- Updated @lde/distribution-probe to 0.1.8
- Updated @lde/sparql-importer to 0.6.3
- Updated @lde/dataset to 0.7.5

## 0.30.8 (2026-06-10)

### 🩹 Fixes

- **pipeline:** prefer the most recent of register and HTTP dates for dump change detection ([#447](https://github.com/ldelements/lde/pull/447))

## 0.30.7 (2026-06-08)

### 🧱 Updated Dependencies

- Updated @lde/distribution-probe to 0.1.7

## 0.30.6 (2026-06-08)

### 🧱 Updated Dependencies

- Updated @lde/distribution-probe to 0.1.6

## 0.30.5 (2026-06-08)

### 🚀 Features

- make VoID stage executors wrappable with quad transforms ([#438](https://github.com/ldelements/lde/pull/438))

## 0.30.4 (2026-06-01)

### 🧱 Updated Dependencies

- Updated @lde/distribution-probe to 0.1.5

## 0.30.3 (2026-05-28)

### 🚀 Features

- **pipeline:** adaptive per-endpoint SPARQL timeouts ([#421](https://github.com/ldelements/lde/pull/421), [#419](https://github.com/ldelements/lde/issues/419))

## 0.30.2 (2026-05-27)

### 🧱 Updated Dependencies

- Updated @lde/distribution-probe to 0.1.4

## 0.30.1 (2026-05-27)

### 🚀 Features

- **pipeline:** add graphIri option to SparqlUpdateWriter ([#409](https://github.com/ldelements/lde/pull/409))

## 0.30.0 (2026-05-27)

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

- Updated @lde/dataset-registry-client to 0.8.0

## 0.29.2 (2026-05-22)

### 🚀 Features

- **pipeline-shacl-sampler:** support namespace aliases ([#398](https://github.com/ldelements/lde/pull/398))

### 🧱 Updated Dependencies

- Updated @lde/dataset-registry-client to 0.7.9

## 0.29.1 (2026-05-21)

### 🧱 Updated Dependencies

- Updated @lde/dataset-registry-client to 0.7.8
- Updated @lde/distribution-probe to 0.1.3
- Updated @lde/sparql-importer to 0.6.2
- Updated @lde/dataset to 0.7.4

## 0.29.0 (2026-05-18)

### 🚀 Features

- **pipeline:** add maxResults option to SparqlItemSelector ([36d6e89](https://github.com/ldelements/lde/commit/36d6e89))

## 0.28.14 (2026-05-15)

### 🚀 Features

- **pipeline-shacl-sampler:** add per-class sampling stages derived from SHACL ([#381](https://github.com/ldelements/lde/pull/381))

## 0.28.13 (2026-04-28)

### 🚀 Features

- **docgen:** deep-merge user-supplied JSON-LD frame with built-in default ([#366](https://github.com/ldelements/lde/pull/366), [#313](https://github.com/ldelements/lde/issues/313))

### 🧱 Updated Dependencies

- Updated @lde/dataset-registry-client to 0.7.7

## 0.28.12 (2026-04-28)

### 🩹 Fixes

- **pipeline:** propagate Last-Modified from probe to candidate distribution ([#365](https://github.com/ldelements/lde/pull/365), [#296](https://github.com/ldelements/lde/issues/296))

## 0.28.11 (2026-04-23)

### 🚀 Features

- consolidate probing, rename sparql-monitor to distribution-monitor ([#358](https://github.com/ldelements/lde/pull/358))

### 🧱 Updated Dependencies

- Updated @lde/dataset-registry-client to 0.7.6
- Updated @lde/local-sparql-endpoint to 0.2.13
- Updated @lde/distribution-probe to 0.1.2
- Updated @lde/sparql-importer to 0.6.1
- Updated @lde/sparql-server to 0.4.11
- Updated @lde/dataset to 0.7.3

## 0.28.10 (2026-04-23)

### 🧱 Updated Dependencies

- Updated @lde/distribution-probe to 0.1.1

## 0.28.9 (2026-04-17)

### 🧱 Updated Dependencies

- Updated @lde/dataset-registry-client to 0.7.5

## 0.28.8 (2026-04-15)

### 🚀 Features

- **pipeline:** add generic namespace normalization plugin ([#337](https://github.com/ldelements/lde/pull/337))

## 0.28.7 (2026-04-09)

### 🩹 Fixes

- **pipeline:** fix race condition in tee that skips quads for slow consumers ([#336](https://github.com/ldelements/lde/pull/336))

## 0.28.6 (2026-04-06)

### 🚀 Features

- **pipeline:** add schema.org namespace normalization plugin ([#335](https://github.com/ldelements/lde/pull/335))

## 0.28.5 (2026-03-24)

### 🚀 Features

- **pipeline:** add deduplicate option to SparqlConstructExecutor ([#309](https://github.com/ldelements/lde/pull/309))

## 0.28.4 (2026-03-24)

### 🩹 Fixes

- **pipeline:** share maxConcurrency across parallel executors ([#312](https://github.com/ldelements/lde/pull/312))

## 0.28.3 (2026-03-24)

### 🚀 Features

- **pipeline:** run executors in parallel per batch ([#311](https://github.com/ldelements/lde/pull/311))

## 0.28.2 (2026-03-23)

### 🚀 Features

- **pipeline:** add lineBuffer option to work around N3.js chunk-splitting bug ([#304](https://github.com/ldelements/lde/pull/304))

### ❤️ Thank You

- David de Boer @ddeboer

## 0.28.1 (2026-03-23)

### 🚀 Features

- **pipeline:** use batchSize as selector page size ([#301](https://github.com/ldelements/lde/pull/301))

### ❤️ Thank You

- David de Boer @ddeboer

## 0.28.0 (2026-03-22)

### 🚀 Features

- ⚠️  detect and correct MIME type mismatches in distribution imports ([#291](https://github.com/ldelements/lde/pull/291))

### ⚠️  Breaking Changes

- detect and correct MIME type mismatches in distribution imports  ([#291](https://github.com/ldelements/lde/pull/291))
  Downloader.download() returns DownloadResult instead
  of string; qleverOptions on createQlever() renamed to indexOptions.

### 🧱 Updated Dependencies

- Updated @lde/sparql-importer to 0.6.0

### ❤️ Thank You

- David de Boer @ddeboer

## 0.27.0 (2026-03-20)

### 🧱 Updated Dependencies

- Updated @lde/sparql-importer to 0.5.0

## 0.26.0 (2026-03-19)

### 🚀 Features

- **pipeline:** validate SPARQL probe response body and drain fetch responses ([#261](https://github.com/ldelements/lde/pull/261))

### ❤️ Thank You

- David de Boer @ddeboer

## 0.25.3 (2026-03-19)

### 🩹 Fixes

- **pipeline:** handle `NotSupported` result from importer to prevent orphaned spinner ([#259](https://github.com/ldelements/lde/pull/259))

### ❤️ Thank You

- David de Boer @ddeboer

## 0.25.2 (2026-03-19)

### 🩹 Fixes

- **pipeline:** eliminate FanOutWriter memory growth via tee pattern ([#258](https://github.com/ldelements/lde/pull/258))

### ❤️ Thank You

- David de Boer @ddeboer

## 0.25.1 (2026-03-19)

### 🩹 Fixes

- **pipeline:** handle empty distributions and eliminate duplicate probing ([#257](https://github.com/ldelements/lde/pull/257))

### 🧱 Updated Dependencies

- Updated @lde/sparql-importer to 0.4.2

### ❤️ Thank You

- David de Boer @ddeboer

## 0.25.0 (2026-03-18)

### 🚀 Features

- **pipeline:** report memory usage (RSS) during pipeline execution ([#255](https://github.com/ldelements/lde/pull/255))

### ❤️ Thank You

- David de Boer @ddeboer

## 0.24.4 (2026-03-16)

### 🩹 Fixes

- **dataset:** guard SPARQL IRI interpolation against injection ([99933a7](https://github.com/ldelements/lde/commit/99933a7))

### 🧱 Updated Dependencies

- Updated @lde/dataset-registry-client to 0.7.4
- Updated @lde/sparql-importer to 0.4.1
- Updated @lde/dataset to 0.7.2

### ❤️ Thank You

- David de Boer @ddeboer

## 0.24.3 (2026-03-16)

### 🩹 Fixes

- **pipeline:** avoid concurrent ora spinners and fix misleading skip message ([#246](https://github.com/ldelements/lde/pull/246))

### ❤️ Thank You

- David de Boer @ddeboer

## 0.24.2 (2026-03-16)

### 🩹 Fixes

- **pipeline:** handle WriteStream errors in FileWriter to prevent silent failures ([997401c](https://github.com/ldelements/lde/commit/997401c))
- **pipeline:** add 5-minute timeout to SPARQL UPDATE requests ([d9fb604](https://github.com/ldelements/lde/commit/d9fb604))
- **pipeline:** destroy read streams in readFiles to prevent file descriptor leaks ([7a2bf47](https://github.com/ldelements/lde/commit/7a2bf47))

### ❤️ Thank You

- David de Boer @ddeboer

## 0.24.1 (2026-03-16)

### 🩹 Fixes

- **pipeline:** replace all #subjectFilter# occurrences in query templates ([#244](https://github.com/ldelements/lde/pull/244))

### ❤️ Thank You

- David de Boer @ddeboer

## 0.24.0 (2026-03-13)

### 🚀 Features

- **pipeline:** retry on transient network errors, not just HTTP 502/503/504 ([#237](https://github.com/ldelements/lde/pull/237))

### ❤️ Thank You

- David de Boer @ddeboer

## 0.23.0 (2026-03-13)

### 🚀 Features

- **pipeline:** add retry logic, perClass conversion, and tuneable concurrency ([#235](https://github.com/ldelements/lde/pull/235))

### ❤️ Thank You

- David de Boer

## 0.22.1 (2026-03-13)

### 🩹 Fixes

- **pipeline:** inject VALUES into innermost subquery for per-class queries ([#234](https://github.com/ldelements/lde/pull/234))

### ❤️ Thank You

- David de Boer @ddeboer

## 0.22.0 (2026-03-13)

### 🚀 Features

- **pipeline:** decouple SHACL validation from write path when onInvalid is 'write' ([#230](https://github.com/ldelements/lde/pull/230))

### ❤️ Thank You

- David de Boer @ddeboer

## 0.21.0 (2026-03-12)

### 🚀 Features

- **pipeline:** add "Importing…" spinner with elapsed time ([#220](https://github.com/ldelements/lde/pull/220))

### ❤️ Thank You

- David de Boer @ddeboer

## 0.20.0 (2026-03-09)

### 🚀 Features

- **pipeline:** add SHACL validation as a stage option ([#218](https://github.com/ldelements/lde/pull/218))

### ❤️ Thank You

- David de Boer

## 0.19.0 (2026-03-08)

### 🚀 Features

- **pipeline:** include triple count in import result reporting ([#217](https://github.com/ldelements/lde/pull/217))

### 🧱 Updated Dependencies

- Updated @lde/sparql-importer to 0.4.0

### ❤️ Thank You

- David de Boer @ddeboer

## 0.18.0 (2026-03-07)

### 🚀 Features

- **pipeline:** report distribution probe results as they complete ([#215](https://github.com/ldelements/lde/pull/215))

### ❤️ Thank You

- David de Boer @ddeboer

## 0.17.1 (2026-03-06)

### 🧱 Updated Dependencies

- Updated @lde/dataset-registry-client to 0.7.3
- Updated @lde/sparql-importer to 0.3.1
- Updated @lde/dataset to 0.7.1

## 0.17.0 (2026-03-06)

### 🚀 Features

- **pipeline:** add distribution selection strategy to ImportResolver ([c3406b4](https://github.com/ldelements/lde/commit/c3406b4))

### ❤️ Thank You

- David de Boer @ddeboer

## 0.16.0 (2026-03-06)

### 🚀 Features

- **pipeline:** show elapsed time and compact numbers during stage progress ([#208](https://github.com/ldelements/lde/pull/208))

### ❤️ Thank You

- David de Boer @ddeboer

## 0.15.2 (2026-03-06)

### 🧱 Updated Dependencies

- Updated @lde/dataset-registry-client to 0.7.2

## 0.15.1 (2026-03-06)

### 🩹 Fixes

- **dataset-registry-client:** pass search criteria via ldkit's `where` option ([#205](https://github.com/ldelements/lde/pull/205))

### 🧱 Updated Dependencies

- Updated @lde/dataset-registry-client to 0.7.1

### ❤️ Thank You

- David de Boer @ddeboer

## 0.15.0 (2026-03-02)

### 🚀 Features

- **pipeline:** show dataset selection duration in console reporter ([#184](https://github.com/ldelements/lde/pull/184))

### ❤️ Thank You

- David de Boer @ddeboer

## 0.14.0 (2026-03-02)

### 🚀 Features

- **pipeline:** add flush() to Writer and Turtle prefix support to FileWriter ([#182](https://github.com/ldelements/lde/pull/182))

### ❤️ Thank You

- David de Boer @ddeboer

## 0.13.0 (2026-02-28)

### 🚀 Features

- **pipeline:** refactor ProgressReporter with domain objects and extract console reporter ([#178](https://github.com/ldelements/lde/pull/178))

### ❤️ Thank You

- David de Boer @ddeboer

## 0.12.0 (2026-02-28)

### 🚀 Features

- **pipeline:** add distribution analysis and selection reporting ([#176](https://github.com/ldelements/lde/pull/176))

### ❤️ Thank You

- David de Boer @ddeboer

## 0.11.0 (2026-02-27)

### 🧱 Updated Dependencies

- Updated @lde/dataset-registry-client to 0.7.0
- Updated @lde/sparql-importer to 0.3.0
- Updated @lde/dataset to 0.7.0

## 0.10.0 (2026-02-27)

### 🚀 Features

- **pipeline:** isolate errors per stage in processDataset() ([#160](https://github.com/ldelements/lde/pull/160))

### ❤️ Thank You

- David de Boer @ddeboer

## 0.9.0 (2026-02-27)

### 🚀 Features

- **pipeline:** make FileWriter replacement character configurable ([#159](https://github.com/ldelements/lde/pull/159))

### ❤️ Thank You

- David de Boer @ddeboer

## 0.8.1 (2026-02-27)

### 🩹 Fixes

- **pipeline:** preserve subjectFilter when importing distributions ([#150](https://github.com/ldelements/lde/pull/150))

### ❤️ Thank You

- David de Boer @ddeboer

## 0.8.0 (2026-02-27)

### 🚀 Features

- change FileWriter default format to N-Triples ([#149](https://github.com/ldelements/lde/pull/149))

### ❤️ Thank You

- David de Boer @ddeboer

## 0.7.1 (2026-02-20)

### 🩹 Fixes

- **pipeline:** clear graph and truncate file at most once per writer instance ([#140](https://github.com/ldelements/lde/pull/140))

### ❤️ Thank You

- David de Boer @ddeboer

## 0.7.0 (2026-02-18)

### 🚀 Features

- document pipeline changes ([5489e18](https://github.com/ldelements/lde/commit/5489e18))

### ❤️ Thank You

- David de Boer @ddeboer

## 0.6.32 (2026-02-16)

### 🧱 Updated Dependencies

- Updated @lde/dataset-registry-client to 0.6.17
- Updated @lde/local-sparql-endpoint to 0.2.12
- Updated @lde/sparql-importer to 0.2.10
- Updated @lde/sparql-server to 0.4.10
- Updated @lde/dataset to 0.6.10

## 0.6.31 (2026-02-16)

### 🚀 Features

- **pipeline:** add SparqlServer support to distribution resolver ([#118](https://github.com/ldelements/lde/pull/118))

### ❤️ Thank You

- David de Boer

## 0.6.30 (2026-02-16)

### 🩹 Fixes

- **pipeline:** don't mark empty distributions as valid ([#114](https://github.com/ldelements/lde/pull/114))

### ❤️ Thank You

- David de Boer @ddeboer

## 0.6.29 (2026-02-16)

This was a version bump only for @lde/pipeline to align it with other projects, there were no code changes.

## 0.6.28 (2026-02-15)

This was a version bump only for @lde/pipeline to align it with other projects, there were no code changes.

## 0.6.27 (2026-02-15)

This was a version bump only for @lde/pipeline to align it with other projects, there were no code changes.

## 0.6.26 (2026-02-15)

### 🚀 Features

- **pipeline:** defer #subjectFilter# substitution to runtime ([#107](https://github.com/ldelements/lde/pull/107))

### ❤️ Thank You

- David de Boer @ddeboer

## 0.6.25 (2026-02-13)

### 🚀 Features

- **pipeline:** rewrite Pipeline with multi-stage chaining ([#105](https://github.com/ldelements/lde/pull/105))

### 🧱 Updated Dependencies

- Updated @lde/dataset-registry-client to 0.6.16
- Updated @lde/local-sparql-endpoint to 0.2.11
- Updated @lde/sparql-importer to 0.2.9
- Updated @lde/dataset to 0.6.9

### ❤️ Thank You

- David de Boer @ddeboer

## 0.6.24 (2026-02-13)

### 🚀 Features

- **pipeline:** add concurrent executor execution in Stage.run() ([#103](https://github.com/ldelements/lde/pull/103))

### 🧱 Updated Dependencies

- Updated @lde/dataset-registry-client to 0.6.15
- Updated @lde/local-sparql-endpoint to 0.2.10

### ❤️ Thank You

- David de Boer @ddeboer

## 0.6.23 (2026-02-12)

### 🚀 Features

- **pipeline:** support authentication in SparqlUpdateWriter ([#91](https://github.com/ldelements/lde/pull/91))

### ❤️ Thank You

- David de Boer @ddeboer

## 0.6.22 (2026-02-12)

This was a version bump only for @lde/pipeline to align it with other projects, there were no code changes.

## 0.6.21 (2026-02-12)

### 🚀 Features

- **pipeline:** add CLEAR GRAPH and on-the-fly batching to SparqlUpdateWriter ([#89](https://github.com/ldelements/lde/pull/89))

### ❤️ Thank You

- David de Boer @ddeboer

## 0.6.20 (2026-02-12)

### 🚀 Features

- **pipeline:** integrate Writer into Stage.run() ([#87](https://github.com/ldelements/lde/pull/87))

### ❤️ Thank You

- David de Boer @ddeboer

## 0.6.19 (2026-02-12)

### 🚀 Features

- **pipeline:** batch selector bindings to executor ([#85](https://github.com/ldelements/lde/pull/85))

### ❤️ Thank You

- David de Boer @ddeboer

## 0.6.18 (2026-02-12)

### 🚀 Features

- **pipeline:** add resolveDistributions stage function ([#84](https://github.com/ldelements/lde/pull/84), [#76](https://github.com/ldelements/lde/issues/76))

### ❤️ Thank You

- David de Boer @ddeboer

## 0.6.17 (2026-02-12)

This was a version bump only for @lde/pipeline to align it with other projects, there were no code changes.

## 0.6.16 (2026-02-12)

This was a version bump only for @lde/pipeline to align it with other projects, there were no code changes.

## 0.6.15 (2026-02-11)

### 🚀 Features

- **pipeline:** extract DistributionResolver, pass distribution explicitly ([#73](https://github.com/ldelements/lde/pull/73))

### ❤️ Thank You

- David de Boer @ddeboer

## 0.6.14 (2026-02-11)

### 🧱 Updated Dependencies

- Updated @lde/dataset-registry-client to 0.6.14
- Updated @lde/local-sparql-endpoint to 0.2.9
- Updated @lde/sparql-importer to 0.2.8
- Updated @lde/sparql-server to 0.4.8
- Updated @lde/dataset to 0.6.8

## 0.6.13 (2026-02-09)

### 🚀 Features

- **pipeline:** AST-based query manipulation for SparqlConstructExecutor ([#69](https://github.com/ldelements/lde/pull/69))

### ❤️ Thank You

- David de Boer @ddeboer

## 0.6.12 (2026-02-09)

### 🚀 Features

- **pipeline:** add StageSelector interface and SparqlSelector ([#68](https://github.com/ldelements/lde/pull/68))

### 🧱 Updated Dependencies

- Updated @lde/dataset-registry-client to 0.6.12
- Updated @lde/local-sparql-endpoint to 0.2.7
- Updated @lde/sparql-importer to 0.2.6
- Updated @lde/sparql-server to 0.4.6
- Updated @lde/dataset to 0.6.6

### ❤️ Thank You

- David de Boer @ddeboer

## 0.6.11 (2026-02-09)

### 🚀 Features

- **pipeline:** add Stage abstraction for pipeline composition ([#67](https://github.com/ldelements/lde/pull/67))

### 🧱 Updated Dependencies

- Updated @lde/dataset-registry-client to 0.6.11
- Updated @lde/local-sparql-endpoint to 0.2.6

### ❤️ Thank You

- David de Boer @ddeboer

## 0.6.10 (2026-02-09)

### 🧱 Updated Dependencies

- Updated @lde/dataset-registry-client to 0.6.10
- Updated @lde/sparql-importer to 0.2.5
- Updated @lde/sparql-server to 0.4.5
- Updated @lde/dataset to 0.6.5

## 0.6.9 (2026-02-09)

### 🧱 Updated Dependencies

- Updated @lde/dataset-registry-client to 0.6.9
- Updated @lde/local-sparql-endpoint to 0.2.5

## 0.6.8 (2026-02-09)

### 🧱 Updated Dependencies

- Updated @lde/dataset-registry-client to 0.6.8
- Updated @lde/sparql-importer to 0.2.4
- Updated @lde/sparql-server to 0.4.4
- Updated @lde/dataset to 0.6.4

## 0.6.7 (2026-02-09)

### 🧱 Updated Dependencies

- Updated @lde/dataset-registry-client to 0.6.7
- Updated @lde/local-sparql-endpoint to 0.2.4

## 0.6.6 (2026-02-09)

### 🧱 Updated Dependencies

- Updated @lde/dataset-registry-client to 0.6.6
- Updated @lde/sparql-importer to 0.2.3
- Updated @lde/sparql-server to 0.4.3
- Updated @lde/dataset to 0.6.3

## 0.6.5 (2026-02-09)

### 🧱 Updated Dependencies

- Updated @lde/dataset-registry-client to 0.6.5
- Updated @lde/local-sparql-endpoint to 0.2.3

## 0.6.4 (2026-02-09)

### 🧱 Updated Dependencies

- Updated @lde/dataset-registry-client to 0.6.4
- Updated @lde/sparql-importer to 0.2.2
- Updated @lde/sparql-server to 0.4.2
- Updated @lde/dataset to 0.6.2

## 0.6.3 (2026-02-09)

### 🧱 Updated Dependencies

- Updated @lde/dataset-registry-client to 0.6.3
- Updated @lde/local-sparql-endpoint to 0.2.2

## 0.6.2 (2026-02-09)

### 🧱 Updated Dependencies

- Updated @lde/dataset-registry-client to 0.6.2
- Updated @lde/sparql-importer to 0.2.1
- Updated @lde/sparql-server to 0.4.1
- Updated @lde/dataset to 0.6.1

## 0.6.1 (2026-02-09)

### 🧱 Updated Dependencies

- Updated @lde/dataset-registry-client to 0.6.1
- Updated @lde/local-sparql-endpoint to 0.2.1

## 0.6.0 (2026-02-07)

### 🚀 Features

- add pipeline-void package and extend pipeline with analyzers, writers, and SPARQL utilities ([#48](https://github.com/ldelements/lde/pull/48))

### 🧱 Updated Dependencies

- Updated @lde/dataset-registry-client to 0.6.0
- Updated @lde/local-sparql-endpoint to 0.2.0
- Updated @lde/sparql-importer to 0.2.0
- Updated @lde/sparql-server to 0.4.0
- Updated @lde/dataset to 0.6.0

### ❤️ Thank You

- David de Boer @ddeboer

## 0.5.1 (2026-02-06)

### 🧱 Updated Dependencies

- Updated @lde/dataset-registry-client to 0.5.0
- Updated @lde/local-sparql-endpoint to 0.1.0
- Updated @lde/sparql-importer to 0.1.0
- Updated @lde/sparql-server to 0.3.0
- Updated @lde/dataset to 0.5.0

## 0.5.0 (2026-01-22)

### 🚀 Features

- **sparql-monitor:** add CLI with TypeScript config support ([#38](https://github.com/ldelements/lde/pull/38))

### ❤️ Thank You

- David de Boer @ddeboer

## 0.4.0 (2026-01-20)

### 🚀 Features

- add @lde/sparql-monitor package ([#37](https://github.com/ldelements/lde/pull/37))

### ❤️ Thank You

- David de Boer @ddeboer

## 0.3.8 (2025-10-09)

### 🧱 Updated Dependencies

- Updated @lde/dataset-registry-client to 0.4.4
- Updated @lde/sparql-importer to 0.0.9
- Updated @lde/dataset to 0.4.2

## 0.3.7 (2025-10-06)

### 🩹 Fixes

- add repository URL ([7bb2f77](https://github.com/ldelements/lde/commit/7bb2f77))

### ❤️ Thank You

- David de Boer @ddeboer

## 0.3.6 (2025-10-06)

### 🧱 Updated Dependencies

- Updated @lde/sparql-importer to 0.0.8

## 0.3.5 (2025-10-06)

### 🧱 Updated Dependencies

- Updated @lde/dataset-registry-client to 0.4.3
- Updated @lde/local-sparql-endpoint to 0.0.3
- Updated @lde/sparql-server to 0.2.2

## 0.3.4 (2025-10-06)

### 🧱 Updated Dependencies

- Updated @lde/dataset-registry-client to 0.4.2
- Updated @lde/sparql-importer to 0.0.7
- Updated @lde/dataset to 0.4.1

## 0.3.3 (2025-10-06)

### 🧱 Updated Dependencies

- Updated @lde/dataset-registry-client to 0.4.1
- Updated @lde/sparql-importer to 0.0.6
- Updated @lde/dataset to 0.4.0

## 0.3.2 (2025-08-06)

### 🧱 Updated Dependencies

- Updated @lde/dataset-registry-client to 0.4.0

## 0.3.1 (2025-07-31)

### 🩹 Fixes

- standardize exports field order in all packages ([#20](https://github.com/ldelements/lde/pull/20))

### 🧱 Updated Dependencies

- Updated @lde/dataset-registry-client to 0.3.1
- Updated @lde/local-sparql-endpoint to 0.0.2
- Updated @lde/sparql-importer to 0.0.5
- Updated @lde/sparql-server to 0.2.1
- Updated @lde/dataset to 0.3.1

### ❤️ Thank You

- David de Boer @ddeboer

## 0.3.0 (2025-07-29)

### 🚀 Features

- extend dataset properties ([#15](https://github.com/ldelements/lde/pull/15))

### 🧱 Updated Dependencies

- Updated @lde/dataset-registry-client to 0.3.0
- Updated @lde/sparql-importer to 0.0.4
- Updated @lde/dataset to 0.3.0

### ❤️ Thank You

- David de Boer @ddeboer

## 0.2.0 (2025-07-28)

### 🚀 Features

- add pipeline ([#11](https://github.com/ldelements/lde/pull/11))

### 🧱 Updated Dependencies

- Updated @lde/dataset-registry-client to 0.2.0
- Updated @lde/sparql-importer to 0.0.3
- Updated @lde/sparql-server to 0.2.0
- Updated @lde/dataset to 0.2.0

### ❤️ Thank You

- David de Boer @ddeboer