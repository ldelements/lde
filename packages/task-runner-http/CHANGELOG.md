## 0.2.0 (2026-10-30)

### 🧱 Updated Dependencies

- Updated @lde/task-runner-native to 0.4.0
- Updated @lde/task-runner to 0.4.0

## 0.1.0 (2026-10-15)

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

- Updated @lde/task-runner-native to 0.3.0
- Updated @lde/task-runner to 0.3.0