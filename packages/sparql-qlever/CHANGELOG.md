## 0.14.8 (2026-06-15)

### 🧱 Updated Dependencies

- Updated @lde/distribution-downloader to 0.6.4
- Updated @lde/sparql-importer to 0.6.4
- Updated @lde/dataset to 0.7.6

## 0.14.7 (2026-06-10)

### 🧱 Updated Dependencies

- Updated @lde/distribution-downloader to 0.6.3
- Updated @lde/sparql-importer to 0.6.3
- Updated @lde/dataset to 0.7.5

## 0.14.6 (2026-06-08)

### 🚀 Features

- **sparql-qlever:** support RDF/XML distributions on import ([#439](https://github.com/ldelements/lde/pull/439))

## 0.14.5 (2026-05-29)

### 🩹 Fixes

- **sparql-qlever:** shell-escape data filenames in the QLever index command ([#424](https://github.com/ldelements/lde/pull/424))

## 0.14.4 (2026-05-21)

### 🚀 Features

- **sparql-qlever:** support JSON-LD and zipped distributions ([bdf48f0](https://github.com/ldelements/lde/commit/bdf48f0))

### 🧱 Updated Dependencies

- Updated @lde/distribution-downloader to 0.6.2
- Updated @lde/sparql-importer to 0.6.2
- Updated @lde/dataset to 0.7.4

## 0.14.3 (2026-04-23)

### 🧱 Updated Dependencies

- Updated @lde/distribution-downloader to 0.6.1
- Updated @lde/task-runner-docker to 0.2.13
- Updated @lde/task-runner-native to 0.2.14
- Updated @lde/sparql-importer to 0.6.1
- Updated @lde/wait-for-sparql to 0.2.12
- Updated @lde/sparql-server to 0.4.11
- Updated @lde/task-runner to 0.2.11
- Updated @lde/dataset to 0.7.3

## 0.14.2 (2026-03-23)

### 🚀 Features

- **sparql-qlever:** add cache-max-size option to Server ([#306](https://github.com/ldelements/lde/pull/306))

### ❤️ Thank You

- David de Boer @ddeboer

## 0.14.1 (2026-03-23)

### 🧱 Updated Dependencies

- Updated @lde/task-runner-docker to 0.2.12

## 0.14.0 (2026-03-22)

### 🚀 Features

- ⚠️  detect and correct MIME type mismatches in distribution imports ([#291](https://github.com/ldelements/lde/pull/291))

### ⚠️  Breaking Changes

- detect and correct MIME type mismatches in distribution imports  ([#291](https://github.com/ldelements/lde/pull/291))
  Downloader.download() returns DownloadResult instead
  of string; qleverOptions on createQlever() renamed to indexOptions.

### 🧱 Updated Dependencies

- Updated @lde/distribution-downloader to 0.6.0
- Updated @lde/sparql-importer to 0.6.0

### ❤️ Thank You

- David de Boer @ddeboer

## 0.13.0 (2026-03-21)

### 🚀 Features

- ⚠️  **sparql-qlever:** expose configurable QLever server options ([#289](https://github.com/ldelements/lde/pull/289), [#288](https://github.com/ldelements/lde/issues/288))

### ⚠️  Breaking Changes

- **sparql-qlever:** expose configurable QLever server options  ([#289](https://github.com/ldelements/lde/pull/289), [#288](https://github.com/ldelements/lde/issues/288))
  `qleverOptions` renamed to `indexOptions`;
  `queryTimeout` replaced by `serverOptions`.
  * docs(sparql-qlever): document index and server options in README

### ❤️ Thank You

- David de Boer @ddeboer

## 0.12.2 (2026-03-21)

### 🚀 Features

- **sparql-qlever:** add queryTimeout option to QLever server ([#288](https://github.com/ldelements/lde/pull/288))

### ❤️ Thank You

- David de Boer @ddeboer

## 0.12.1 (2026-03-21)

### 🩹 Fixes

- **sparql-qlever:** fix conflicting --parse-parallel flags on import retry ([#287](https://github.com/ldelements/lde/pull/287))

### ❤️ Thank You

- David de Boer

## 0.12.0 (2026-03-20)

### 🚀 Features

- ⚠️  **sparql-qlever:** tune QLever index build for large datasets ([#263](https://github.com/ldelements/lde/pull/263))

### ⚠️  Breaking Changes

- **sparql-qlever:** tune QLever index build for large datasets  ([#263](https://github.com/ldelements/lde/pull/263))

### 🧱 Updated Dependencies

- Updated @lde/sparql-importer to 0.5.0

### ❤️ Thank You

- David de Boer @ddeboer

## 0.11.0 (2026-03-19)

### 🚀 Features

- **sparql-qlever:** retry TTL indexing with parallel parsing disabled on multiline literal error ([#260](https://github.com/ldelements/lde/pull/260))

### ❤️ Thank You

- David de Boer @ddeboer

## 0.10.2 (2026-03-19)

### 🩹 Fixes

- **pipeline:** handle empty distributions and eliminate duplicate probing ([#257](https://github.com/ldelements/lde/pull/257))

### 🧱 Updated Dependencies

- Updated @lde/sparql-importer to 0.4.2

### ❤️ Thank You

- David de Boer @ddeboer

## 0.10.1 (2026-03-16)

### 🩹 Fixes

- **sparql-qlever:** use gunzip -c instead of zcat for macOS compatibility ([#250](https://github.com/ldelements/lde/pull/250))

### ❤️ Thank You

- David de Boer @ddeboer

## 0.10.0 (2026-03-16)

### 🚀 Features

- **sparql-qlever:** cache QLever indices across pipeline runs ([#249](https://github.com/ldelements/lde/pull/249))

### ❤️ Thank You

- David de Boer @ddeboer

## 0.9.3 (2026-03-16)

### 🧱 Updated Dependencies

- Updated @lde/distribution-downloader to 0.5.3
- Updated @lde/sparql-importer to 0.4.1
- Updated @lde/dataset to 0.7.2

## 0.9.2 (2026-03-16)

### 🧱 Updated Dependencies

- Updated @lde/distribution-downloader to 0.5.2
- Updated @lde/task-runner-native to 0.2.13

## 0.9.1 (2026-03-15)

### 🩹 Fixes

- **sparql-qlever:** unify mountDir/cwd into dataDir and fix NativeTaskRunner bugs ([#239](https://github.com/ldelements/lde/pull/239))

### 🧱 Updated Dependencies

- Updated @lde/task-runner-native to 0.2.12

### ❤️ Thank You

- David de Boer @ddeboer

## 0.9.0 (2026-03-08)

### 🚀 Features

- **pipeline:** include triple count in import result reporting ([#217](https://github.com/ldelements/lde/pull/217))

### 🧱 Updated Dependencies

- Updated @lde/sparql-importer to 0.4.0

### ❤️ Thank You

- David de Boer @ddeboer

## 0.8.6 (2026-03-07)

### 🩹 Fixes

- **sparql-qlever:** filter unsupported MIME types before downloading ([#214](https://github.com/ldelements/lde/pull/214))

### ❤️ Thank You

- David de Boer @ddeboer

## 0.8.5 (2026-03-06)

### 🩹 Fixes

- **sparql-qlever:** default port to 7001 in createQlever ([#211](https://github.com/ldelements/lde/pull/211))

### ❤️ Thank You

- David de Boer @ddeboer

## 0.8.4 (2026-03-06)

### 🧱 Updated Dependencies

- Updated @lde/distribution-downloader to 0.5.1
- Updated @lde/sparql-importer to 0.3.1
- Updated @lde/dataset to 0.7.1

## 0.8.3 (2026-02-27)

### 🩹 Fixes

- **sparql-qlever:** wait for SPARQL endpoint to be ready after server start ([#175](https://github.com/ldelements/lde/pull/175))

### ❤️ Thank You

- David de Boer @ddeboer

## 0.8.2 (2026-02-27)

### 🧱 Updated Dependencies

- Updated @lde/task-runner-docker to 0.2.11

## 0.8.1 (2026-02-27)

### 🩹 Fixes

- **sparql-qlever:** update QLever CLI binaries to new names ([#172](https://github.com/ldelements/lde/pull/172), [#170](https://github.com/ldelements/lde/issues/170))

### ❤️ Thank You

- David de Boer @ddeboer

## 0.8.0 (2026-02-27)

### 🚀 Features

- **dataset:** replace +gzip media types with dcat:compressFormat ([#167](https://github.com/ldelements/lde/pull/167))

### 🧱 Updated Dependencies

- Updated @lde/distribution-downloader to 0.5.0
- Updated @lde/sparql-importer to 0.3.0
- Updated @lde/dataset to 0.7.0

### ❤️ Thank You

- David de Boer @ddeboer

## 0.7.0 (2026-02-18)

### 🚀 Features

- **sparql-qlever:** add createQlever factory function ([#127](https://github.com/ldelements/lde/pull/127))

### ❤️ Thank You

- David de Boer @ddeboer

## 0.6.12 (2026-02-16)

### 🧱 Updated Dependencies

- Updated @lde/task-runner-docker to 0.2.10
- Updated @lde/wait-for-sparql to 0.2.11

## 0.6.11 (2026-02-13)

### 🧱 Updated Dependencies

- Updated @lde/task-runner-docker to 0.2.9
- Updated @lde/wait-for-sparql to 0.2.10

## 0.6.10 (2026-02-13)

### 🧱 Updated Dependencies

- Updated @lde/wait-for-sparql to 0.2.9

## 0.6.9 (2026-02-11)

### 🧱 Updated Dependencies

- Updated @lde/task-runner-docker to 0.2.8
- Updated @lde/wait-for-sparql to 0.2.8

## 0.6.8 (2026-02-11)

### 🧱 Updated Dependencies

- Updated @lde/task-runner-docker to 0.2.7
- Updated @lde/wait-for-sparql to 0.2.7

## 0.6.7 (2026-02-09)

### 🧱 Updated Dependencies

- Updated @lde/task-runner-docker to 0.2.6
- Updated @lde/wait-for-sparql to 0.2.6

## 0.6.6 (2026-02-09)

### 🧱 Updated Dependencies

- Updated @lde/task-runner-docker to 0.2.5
- Updated @lde/wait-for-sparql to 0.2.5

## 0.6.5 (2026-02-09)

### 🧱 Updated Dependencies

- Updated @lde/task-runner-docker to 0.2.4
- Updated @lde/wait-for-sparql to 0.2.4

## 0.6.4 (2026-02-09)

### 🧱 Updated Dependencies

- Updated @lde/task-runner-docker to 0.2.3
- Updated @lde/wait-for-sparql to 0.2.3

## 0.6.3 (2026-02-09)

### 🧱 Updated Dependencies

- Updated @lde/task-runner-docker to 0.2.2
- Updated @lde/wait-for-sparql to 0.2.2

## 0.6.2 (2026-02-09)

### 🧱 Updated Dependencies

- Updated @lde/task-runner-docker to 0.2.1
- Updated @lde/wait-for-sparql to 0.2.1

## 0.6.1 (2026-02-09)

### 🩹 Fixes

- include vite.config.ts in tsconfig.spec.json for all packages ([#64](https://github.com/ldelements/lde/pull/64))

### ❤️ Thank You

- David de Boer @ddeboer

## 0.6.0 (2026-02-07)

### 🚀 Features

- add pipeline-void package and extend pipeline with analyzers, writers, and SPARQL utilities ([#48](https://github.com/ldelements/lde/pull/48))

### 🧱 Updated Dependencies

- Updated @lde/task-runner-docker to 0.2.0
- Updated @lde/wait-for-sparql to 0.2.0

### ❤️ Thank You

- David de Boer @ddeboer

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

### 🩹 Fixes

- make distribution mediaType optional ([#35](https://github.com/ldelements/lde/pull/35))

### 🧱 Updated Dependencies

- Updated @lde/distribution-downloader to 0.2.7
- Updated @lde/sparql-importer to 0.0.9
- Updated @lde/dataset to 0.4.2

### ❤️ Thank You

- David de Boer @ddeboer

## 0.3.7 (2025-10-06)

### 🩹 Fixes

- add repository URL ([7bb2f77](https://github.com/ldelements/lde/commit/7bb2f77))

### ❤️ Thank You

- David de Boer @ddeboer

## 0.3.6 (2025-10-06)

### 🧱 Updated Dependencies

- Updated @lde/distribution-downloader to 0.2.6
- Updated @lde/sparql-importer to 0.0.8

## 0.3.5 (2025-10-06)

### 🧱 Updated Dependencies

- Updated @lde/task-runner-docker to 0.0.5
- Updated @lde/wait-for-sparql to 0.0.5
- Updated @lde/sparql-server to 0.2.2
- Updated @lde/task-runner to 0.0.5

## 0.3.4 (2025-10-06)

### 🧱 Updated Dependencies

- Updated @lde/distribution-downloader to 0.2.5
- Updated @lde/sparql-importer to 0.0.7
- Updated @lde/dataset to 0.4.1

## 0.3.3 (2025-10-06)

### 🧱 Updated Dependencies

- Updated @lde/distribution-downloader to 0.2.4
- Updated @lde/sparql-importer to 0.0.6
- Updated @lde/dataset to 0.4.0

## 0.3.2 (2025-08-07)

### 🩹 Fixes

- rename distribution-download to distribution-downloader ([#29](https://github.com/ldelements/lde/pull/29))

### 🧱 Updated Dependencies

- Updated @lde/distribution-downloader to 0.2.3

### ❤️ Thank You

- David de Boer @ddeboer

## 0.3.1 (2025-07-31)

### 🩹 Fixes

- standardize exports field order in all packages ([#20](https://github.com/ldelements/lde/pull/20))

### 🧱 Updated Dependencies

- Updated @lde/distribution-download to 0.2.2
- Updated @lde/task-runner-docker to 0.0.4
- Updated @lde/sparql-importer to 0.0.5
- Updated @lde/wait-for-sparql to 0.0.4
- Updated @lde/sparql-server to 0.2.1
- Updated @lde/task-runner to 0.0.4
- Updated @lde/dataset to 0.3.1

### ❤️ Thank You

- David de Boer @ddeboer

## 0.3.0 (2025-07-29)

### 🚀 Features

- extend dataset properties ([#15](https://github.com/ldelements/lde/pull/15))

### 🧱 Updated Dependencies

- Updated @lde/distribution-download to 0.2.1
- Updated @lde/sparql-importer to 0.0.4
- Updated @lde/dataset to 0.3.0

### ❤️ Thank You

- David de Boer @ddeboer

## 0.2.0 (2025-07-28)

### 🚀 Features

- add pipeline ([#11](https://github.com/ldelements/lde/pull/11))

### 🩹 Fixes

- add dataset ([517c270](https://github.com/ldelements/lde/commit/517c270))

### 🧱 Updated Dependencies

- Updated @lde/distribution-download to 0.2.0
- Updated @lde/task-runner-docker to 0.0.3
- Updated @lde/sparql-importer to 0.0.3
- Updated @lde/wait-for-sparql to 0.0.3
- Updated @lde/sparql-server to 0.2.0
- Updated @lde/task-runner to 0.0.3
- Updated @lde/dataset to 0.2.0

### ❤️ Thank You

- David de Boer @ddeboer