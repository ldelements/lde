## 0.8.6 (2026-07-08)

This was a version bump only for @lde/dataset-registry-client to align it with other projects, there were no code changes.

## 0.8.5 (2026-06-26)

### 🧱 Updated Dependencies

- Updated @lde/local-sparql-endpoint to 0.2.14
- Updated @lde/dataset to 0.7.8

## 0.8.4 (2026-06-19)

This was a version bump only for @lde/dataset-registry-client to align it with other projects, there were no code changes.

## 0.8.3 (2026-06-15)

### 🧱 Updated Dependencies

- Updated @lde/dataset to 0.7.7

## 0.8.2 (2026-06-15)

### 🧱 Updated Dependencies

- Updated @lde/dataset to 0.7.6

## 0.8.1 (2026-06-10)

### 🚀 Features

- **dataset:** accept application/rdf+xml as an RDF media type ([#449](https://github.com/ldelements/lde/pull/449))

### 🧱 Updated Dependencies

- Updated @lde/dataset to 0.7.5

## 0.8.0 (2026-05-27)

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

## 0.7.9 (2026-05-22)

### 🚀 Features

- **pipeline-shacl-sampler:** support namespace aliases ([#398](https://github.com/ldelements/lde/pull/398))

## 0.7.8 (2026-05-21)

### 🧱 Updated Dependencies

- Updated @lde/dataset to 0.7.4

## 0.7.7 (2026-04-28)

### 🚀 Features

- **docgen:** deep-merge user-supplied JSON-LD frame with built-in default ([#366](https://github.com/ldelements/lde/pull/366), [#313](https://github.com/ldelements/lde/issues/313))

## 0.7.6 (2026-04-23)

### 🧱 Updated Dependencies

- Updated @lde/local-sparql-endpoint to 0.2.13
- Updated @lde/dataset to 0.7.3

## 0.7.5 (2026-04-17)

### 🚀 Features

- **dataset-registry-client:** expose full DCAT 3 vocabulary ([#356](https://github.com/ldelements/lde/pull/356))

## 0.7.4 (2026-03-16)

### 🧱 Updated Dependencies

- Updated @lde/dataset to 0.7.2

## 0.7.3 (2026-03-06)

### 🧱 Updated Dependencies

- Updated @lde/dataset to 0.7.1

## 0.7.2 (2026-03-06)

### 🩹 Fixes

- **dataset-registry-client:** work around LDkit count() ignoring $id filter ([#207](https://github.com/ldelements/lde/pull/207))

### ❤️ Thank You

- David de Boer @ddeboer

## 0.7.1 (2026-03-06)

### 🩹 Fixes

- **dataset-registry-client:** pass search criteria via ldkit's `where` option ([#205](https://github.com/ldelements/lde/pull/205))

### ❤️ Thank You

- David de Boer @ddeboer

## 0.7.0 (2026-02-27)

### 🚀 Features

- **dataset:** replace +gzip media types with dcat:compressFormat ([#167](https://github.com/ldelements/lde/pull/167))

### 🧱 Updated Dependencies

- Updated @lde/dataset to 0.7.0

### ❤️ Thank You

- David de Boer @ddeboer

## 0.6.17 (2026-02-16)

### 🧱 Updated Dependencies

- Updated @lde/local-sparql-endpoint to 0.2.12
- Updated @lde/dataset to 0.6.10

## 0.6.16 (2026-02-13)

### 🧱 Updated Dependencies

- Updated @lde/local-sparql-endpoint to 0.2.11
- Updated @lde/dataset to 0.6.9

## 0.6.15 (2026-02-13)

### 🧱 Updated Dependencies

- Updated @lde/local-sparql-endpoint to 0.2.10

## 0.6.14 (2026-02-11)

### 🧱 Updated Dependencies

- Updated @lde/local-sparql-endpoint to 0.2.9
- Updated @lde/dataset to 0.6.8

## 0.6.13 (2026-02-11)

### 🧱 Updated Dependencies

- Updated @lde/local-sparql-endpoint to 0.2.8
- Updated @lde/dataset to 0.6.7

## 0.6.12 (2026-02-09)

### 🧱 Updated Dependencies

- Updated @lde/local-sparql-endpoint to 0.2.7
- Updated @lde/dataset to 0.6.6

## 0.6.11 (2026-02-09)

### 🧱 Updated Dependencies

- Updated @lde/local-sparql-endpoint to 0.2.6

## 0.6.10 (2026-02-09)

### 🧱 Updated Dependencies

- Updated @lde/dataset to 0.6.5

## 0.6.9 (2026-02-09)

### 🧱 Updated Dependencies

- Updated @lde/local-sparql-endpoint to 0.2.5

## 0.6.8 (2026-02-09)

### 🧱 Updated Dependencies

- Updated @lde/dataset to 0.6.4

## 0.6.7 (2026-02-09)

### 🧱 Updated Dependencies

- Updated @lde/local-sparql-endpoint to 0.2.4

## 0.6.6 (2026-02-09)

### 🧱 Updated Dependencies

- Updated @lde/dataset to 0.6.3

## 0.6.5 (2026-02-09)

### 🧱 Updated Dependencies

- Updated @lde/local-sparql-endpoint to 0.2.3

## 0.6.4 (2026-02-09)

### 🧱 Updated Dependencies

- Updated @lde/dataset to 0.6.2

## 0.6.3 (2026-02-09)

### 🧱 Updated Dependencies

- Updated @lde/local-sparql-endpoint to 0.2.2

## 0.6.2 (2026-02-09)

### 🧱 Updated Dependencies

- Updated @lde/dataset to 0.6.1

## 0.6.1 (2026-02-09)

### 🩹 Fixes

- include vite.config.ts in tsconfig.spec.json for all packages ([#64](https://github.com/ldelements/lde/pull/64))

### 🧱 Updated Dependencies

- Updated @lde/local-sparql-endpoint to 0.2.1

### ❤️ Thank You

- David de Boer @ddeboer

## 0.6.0 (2026-02-07)

### 🚀 Features

- add pipeline-void package and extend pipeline with analyzers, writers, and SPARQL utilities ([#48](https://github.com/ldelements/lde/pull/48))

### 🧱 Updated Dependencies

- Updated @lde/local-sparql-endpoint to 0.2.0
- Updated @lde/dataset to 0.6.0

### ❤️ Thank You

- David de Boer @ddeboer

## 0.5.0 (2026-02-06)

### 🧱 Updated Dependencies

- Updated @lde/local-sparql-endpoint to 0.1.0
- Updated @lde/dataset to 0.5.0

## 0.4.4 (2025-10-09)

### 🩹 Fixes

- make distribution mediaType optional ([#35](https://github.com/ldelements/lde/pull/35))

### 🧱 Updated Dependencies

- Updated @lde/dataset to 0.4.2

### ❤️ Thank You

- David de Boer @ddeboer

## 0.4.3 (2025-10-06)

### 🧱 Updated Dependencies

- Updated @lde/local-sparql-endpoint to 0.0.3

## 0.4.2 (2025-10-06)

### 🩹 Fixes

- add repository URL, required for provenance ([bc1cfd5](https://github.com/ldelements/lde/commit/bc1cfd5))

### 🧱 Updated Dependencies

- Updated @lde/dataset to 0.4.1

### ❤️ Thank You

- David de Boer @ddeboer

## 0.4.1 (2025-10-06)

### 🧱 Updated Dependencies

- Updated @lde/dataset to 0.4.0

## 0.4.0 (2025-08-06)

### 🚀 Features

- optimize count ([#27](https://github.com/ldelements/lde/pull/27))

### ❤️ Thank You

- David de Boer @ddeboer

## 0.3.1 (2025-07-31)

### 🩹 Fixes

- standardize exports field order in all packages ([#20](https://github.com/ldelements/lde/pull/20))

### 🧱 Updated Dependencies

- Updated @lde/local-sparql-endpoint to 0.0.2
- Updated @lde/dataset to 0.3.1

### ❤️ Thank You

- David de Boer @ddeboer

## 0.3.0 (2025-07-29)

### 🚀 Features

- extend dataset properties ([#15](https://github.com/ldelements/lde/pull/15))

### 🧱 Updated Dependencies

- Updated @lde/dataset to 0.3.0

### ❤️ Thank You

- David de Boer @ddeboer

## 0.2.0 (2025-07-28)

### 🚀 Features

- add pipeline ([#11](https://github.com/ldelements/lde/pull/11))
- paginate datasets ([#7](https://github.com/ldelements/lde/pull/7))
- add dataset-registry-client ([#4](https://github.com/ldelements/lde/pull/4))

### 🩹 Fixes

- paginator ([#10](https://github.com/ldelements/lde/pull/10))

### 🧱 Updated Dependencies

- Updated @lde/dataset to 0.2.0

### ❤️ Thank You

- David de Boer @ddeboer