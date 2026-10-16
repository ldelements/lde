## 0.3.0 (2026-10-15)

### 🚀 Features

- ⚠️  run QLever in a sidecar through a localhost task agent ([#906](https://github.com/ldelements/lde/pull/906))

### ⚠️  Breaking Changes

- run QLever in a sidecar through a localhost task agent  ([#906](https://github.com/ldelements/lde/pull/906))
  QleverConfig is now discriminated by a required mode. A config built in code
  rather than with configFromEnvironment() must add mode: 'docker' to keep its Docker setup, or
  use mode: 'remote' (without image and network) for a sidecar.
  * docs(task-runner-http): explain the exec probe against listening on the pod IP
  - Explain why kubelet’s httpGet and tcpSocket probes cannot reach the agent on 127.0.0.1
  - Set the exec probe against letting the agent listen on the pod’s IP address, which would
    open it to the cluster network
  * fix(task-runner-native): report the signal that killed a process
  - Reject wait() with 'Process was killed by SIGKILL' instead of 'Process failed with code null'
    when a signal ends the process
  * feat(task-runner-http): say when a task ran out of memory
  - Have the agent compare its cgroup’s oom_kill count before and after a task, and put the
    container’s memory limit first in the failure when the kernel killed a process meanwhile
  - Say in the lost-agent error that its container most likely ran out of memory, and where
    Kubernetes records why, without needing permission to read pods
  - Test a real out-of-memory kill in a memory-limited QLever sidecar
  * docs(task-runner-http): document out-of-memory reporting and thin the text
  - Explain what wait() reports when the kernel kills one process or the whole container
  - State that the package needs no Kubernetes permissions
  - Explain both restartPolicy settings in the example and the Job apiVersion
  - Name the precedents exactly: the OpenTelemetry Operator copies its agents into an emptyDir,
    Istio runs its proxy as a native sidecar
  - Shorten the probe explanation and point the search-indexer remote section to the reasons
  * refactor(task-runner-http): rename sea to agent
  - Name the directory of the task agent’s executable after what it holds, not after Node’s
    single executable packaging, and its bundle output dist-agent to match
  * docs(sparql-anything): run the JVMs in a sidecar on Kubernetes
  - Describe running the converter’s JVMs through HttpTaskRunner in a JRE sidecar with its own
    memory limit, sized at concurrency × heap plus JVM overhead"
  M	.github/workflows/docker.yml
  M	.gitignore
  M	AGENTS.md
  M	README.md
  M	docs/.vitepress/config.mts
  A	docs/decisions/0027-run-qlever-in-a-sidecar-controlled-through-a-localhost-task-agent.md
  M	docs/reference/packages.md
  M	docs/reference/search-indexer.md
  M	docs/reference/sparql-anything.md
  M	docs/reference/sparql-qlever.md
  A	docs/reference/task-runner-http.md
  M	docs/reference/task-runner-native.md
  M	docs/reference/task-runner.md
  M	eslint.config.mjs
  M	package-lock.json
  M	package.json
  M	packages/search-indexer/src/composition.ts
  M	packages/search-indexer/src/config.ts
  M	packages/search-indexer/test/composition.test.ts
  M	packages/search-indexer/test/config.test.ts
  M	packages/sparql-qlever/package.json
  M	packages/sparql-qlever/src/createQlever.ts
  A	packages/sparql-qlever/test/remote.test.ts
  M	packages/sparql-qlever/tsconfig.lib.json
  M	packages/sparql-qlever/vite.config.ts
  A	packages/task-runner-http/Dockerfile
  A	packages/task-runner-http/README.md
  A	packages/task-runner-http/agent/agent.ts
  A	packages/task-runner-http/agent/main.ts
  A	packages/task-runner-http/agent/rolldown.config.mjs
  A	packages/task-runner-http/agent/sea-config.json
  A	packages/task-runner-http/eslint.config.mjs
  A	packages/task-runner-http/package.json
  A	packages/task-runner-http/src/http-task-runner.ts
  A	packages/task-runner-http/src/index.ts
  A	packages/task-runner-http/src/protocol.ts
  A	packages/task-runner-http/test/index.test.ts
  A	packages/task-runner-http/test/out-of-memory.test.ts
  A	packages/task-runner-http/tsconfig.json
  A	packages/task-runner-http/tsconfig.lib.json
  A	packages/task-runner-http/tsconfig.spec.json
  A	packages/task-runner-http/vite.config.ts
  M	packages/task-runner-native/src/index.ts
  M	packages/task-runner-native/test/index.test.ts
  A	tools/docker-smoke-task-agent.sh
  M	tsconfig.json

### 🧱 Updated Dependencies

- Updated @lde/task-runner to 0.3.0

## 0.2.20 (2026-10-14)

### 🧱 Updated Dependencies

- Updated @lde/task-runner to 0.2.16

## 0.2.19 (2026-09-21)

### 🚀 Features

- **task-runner:** stop running tasks when the process is interrupted ([#837](https://github.com/ldelements/lde/pull/837))

### 🧱 Updated Dependencies

- Updated @lde/task-runner to 0.2.15

## 0.2.18 (2026-08-31)

### 🩹 Fixes

- **task-runner-native:** settle wait() for a process that already closed ([#787](https://github.com/ldelements/lde/pull/787))

## 0.2.17 (2026-08-31)

### 🧱 Updated Dependencies

- Updated @lde/task-runner to 0.2.14

## 0.2.16 (2026-07-24)

### 🧱 Updated Dependencies

- Updated @lde/task-runner to 0.2.13

## 0.2.15 (2026-06-26)

### 🧱 Updated Dependencies

- Updated @lde/task-runner to 0.2.12

## 0.2.14 (2026-04-23)

### 🧱 Updated Dependencies

- Updated @lde/task-runner to 0.2.11

## 0.2.13 (2026-03-16)

### 🩹 Fixes

- **task-runner-native:** prevent process crashes from event listener throws ([2951b8c](https://github.com/ldelements/lde/commit/2951b8c))

### ❤️ Thank You

- David de Boer @ddeboer

## 0.2.12 (2026-03-15)

### 🩹 Fixes

- **sparql-qlever:** unify mountDir/cwd into dataDir and fix NativeTaskRunner bugs ([#239](https://github.com/ldelements/lde/pull/239))

### ❤️ Thank You

- David de Boer @ddeboer

## 0.2.11 (2026-02-16)

### 🧱 Updated Dependencies

- Updated @lde/task-runner to 0.2.10

## 0.2.10 (2026-02-13)

### 🧱 Updated Dependencies

- Updated @lde/task-runner to 0.2.9

## 0.2.9 (2026-02-13)

This was a version bump only for @lde/task-runner-native to align it with other projects, there were no code changes.

## 0.2.8 (2026-02-11)

### 🧱 Updated Dependencies

- Updated @lde/task-runner to 0.2.8

## 0.2.7 (2026-02-11)

### 🧱 Updated Dependencies

- Updated @lde/task-runner to 0.2.7

## 0.2.6 (2026-02-09)

### 🧱 Updated Dependencies

- Updated @lde/task-runner to 0.2.6

## 0.2.5 (2026-02-09)

### 🧱 Updated Dependencies

- Updated @lde/task-runner to 0.2.5

## 0.2.4 (2026-02-09)

### 🧱 Updated Dependencies

- Updated @lde/task-runner to 0.2.4

## 0.2.3 (2026-02-09)

### 🧱 Updated Dependencies

- Updated @lde/task-runner to 0.2.3

## 0.2.2 (2026-02-09)

### 🧱 Updated Dependencies

- Updated @lde/task-runner to 0.2.2

## 0.2.1 (2026-02-09)

### 🧱 Updated Dependencies

- Updated @lde/task-runner to 0.2.1

## 0.2.0 (2026-02-07)

### 🚀 Features

- add pipeline-void package and extend pipeline with analyzers, writers, and SPARQL utilities ([#48](https://github.com/ldelements/lde/pull/48))

### 🧱 Updated Dependencies

- Updated @lde/task-runner to 0.2.0

### ❤️ Thank You

- David de Boer @ddeboer

## 0.1.0 (2026-02-06)

### 🧱 Updated Dependencies

- Updated @lde/task-runner to 0.1.0

## 0.0.5 (2025-10-06)

### 🩹 Fixes

- add repository URL to all packages ([6cf66dc](https://github.com/ldelements/lde/commit/6cf66dc))

### 🧱 Updated Dependencies

- Updated @lde/task-runner to 0.0.5

### ❤️ Thank You

- David de Boer @ddeboer

## 0.0.4 (2025-07-31)

### 🩹 Fixes

- standardize exports field order in all packages ([#20](https://github.com/ldelements/lde/pull/20))

### 🧱 Updated Dependencies

- Updated @lde/task-runner to 0.0.4

### ❤️ Thank You

- David de Boer @ddeboer

## 0.0.3 (2025-07-28)

### 🩹 Fixes

- add dataset ([517c270](https://github.com/ldelements/lde/commit/517c270))

### 🧱 Updated Dependencies

- Updated @lde/task-runner to 0.0.3

### ❤️ Thank You

- David de Boer @ddeboer