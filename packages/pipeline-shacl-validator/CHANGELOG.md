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