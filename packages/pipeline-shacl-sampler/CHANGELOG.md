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