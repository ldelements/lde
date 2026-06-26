## 0.2.2 (2026-06-26)

### 🚀 Features

- **distribution-probe:** add onProgress callback to probeMany ([#527](https://github.com/ldelements/lde/pull/527))

## 0.2.1 (2026-06-25)

### 🚀 Features

- **distribution-probe:** add probeMany with global and per-host concurrency caps ([362788a8](https://github.com/ldelements/lde/commit/362788a8))

## 0.2.0 (2026-06-22)

### 🚀 Features

- ⚠️  **distribution-probe:** bounded-stream reads with opt-in RDF content validation ([#507](https://github.com/ldelements/lde/pull/507), [#505](https://github.com/ldelements/lde/issues/505))

### ⚠️  Breaking Changes

- **distribution-probe:** bounded-stream reads with opt-in RDF content validation  ([#507](https://github.com/ldelements/lde/pull/507), [#505](https://github.com/ldelements/lde/issues/505))
  data-dump bodies are no longer content-validated by
  default. Callers that relied on the probe rejecting empty or triple-less
  dumps must now pass validateRdfContent: true.

## 0.1.13 (2026-06-19)

This was a version bump only for @lde/distribution-probe to align it with other projects, there were no code changes.

## 0.1.12 (2026-06-18)

### 🩹 Fixes

- **distribution-probe:** accept empty and non-n-triples SPARQL CONSTRUCT answers ([#488](https://github.com/ldelements/lde/pull/488))

## 0.1.11 (2026-06-17)

### 🚀 Features

- **distribution-probe:** retry transport errors before reporting unavailable ([#487](https://github.com/ldelements/lde/pull/487))

## 0.1.10 (2026-06-15)

### 🧱 Updated Dependencies

- Updated @lde/dataset to 0.7.7

## 0.1.9 (2026-06-15)

### 🩹 Fixes

- **distribution-probe:** accept declared compressed media type for gzipped downloads ([#466](https://github.com/ldelements/lde/pull/466))

### 🧱 Updated Dependencies

- Updated @lde/dataset to 0.7.6

## 0.1.8 (2026-06-10)

### 🧱 Updated Dependencies

- Updated @lde/dataset to 0.7.5

## 0.1.7 (2026-06-08)

### 🩹 Fixes

- **distribution-probe:** match distribution content type case-insensitively ([#442](https://github.com/ldelements/lde/pull/442))

## 0.1.6 (2026-06-08)

### 🚀 Features

- **distribution-probe:** detect empty RDF distributions across serializations ([#441](https://github.com/ldelements/lde/pull/441))

## 0.1.5 (2026-06-01)

### 🩹 Fixes

- **distribution-probe:** accept SPARQL results as JSON or XML ([#425](https://github.com/ldelements/lde/pull/425))

## 0.1.4 (2026-05-27)

### 🩹 Fixes

- **distribution-probe:** tolerate servers that 406 on specific Accept headers ([#410](https://github.com/ldelements/lde/pull/410), [#12410](https://github.com/ldelements/lde/issues/12410))

## 0.1.3 (2026-05-21)

### 🚀 Features

- **sparql-qlever:** support JSON-LD and zipped distributions ([bdf48f0](https://github.com/ldelements/lde/commit/bdf48f0))

### 🧱 Updated Dependencies

- Updated @lde/dataset to 0.7.4

## 0.1.2 (2026-04-23)

### 🚀 Features

- consolidate probing, rename sparql-monitor to distribution-monitor ([#358](https://github.com/ldelements/lde/pull/358))

### 🧱 Updated Dependencies

- Updated @lde/dataset to 0.7.3

## 0.1.1 (2026-04-23)

This was a version bump only for @lde/distribution-probe to align it with other projects, there were no code changes.