# 27. Run QLever in a sidecar controlled through a localhost task agent

Date: 2026-10-15

## Status

Accepted

Revises the Kubernetes follow-up in
[ADR 16](./0016-ship-the-search-indexer-as-a-config-driven-image.md), which
expected native mode in the pipeline image and called a controllable QLever
sidecar worth designing only if both other options proved unacceptable.
Implements [#905](https://github.com/ldelements/lde/issues/905).

## Context

In native mode, `qlever-index` and `qlever-server` are child processes of the
pipeline. On Kubernetes they share its container’s memory limit, and when the
container runs out of memory, Kubernetes kills the pipeline with them.
`--memory-max-size` does not prevent this: it bounds query processing and the
result cache, not the loaded index. One oversized dump ends the whole run
instead of failing one dataset.

`ImportResolver` already copes with a QLever that dies: the dataset fails and
the next one gets a fresh server. What is missing is isolation.

The Docker-socket path of ADR 16 isolates QLever but is unavailable on
containerd-based clusters. Two Kubernetes-native ways to control a separate
QLever container were considered and rejected:

- **Exec through the Kubernetes API.** Needs `pods/exec`, which RBAC can
  narrow to one pod only by a name known in advance. Job pods get generated
  names, so the pipeline could exec into every pod in the namespace, databases
  included. A fixed name means a permanent worker pod whose limits count
  against the namespace’s quota all day.
- **A pod per task**, the Kubernetes counterpart of `DockerTaskRunner`.
  Whoever can create pods in a namespace can mount, and so read, every Secret
  in it.

Existing tools fall short too. `webhook` and `shell2http` cannot stop a
long-running process. Supervisor only adds programs from its configuration
file. Pueue covers the lifecycle, but is in maintenance-only mode since May
2026, has no Node client, and needs a shared certificate and secret between
containers.

## Decision

- **A new package, `@lde/task-runner-http`**: `HttpTaskRunner`, a
  `TaskRunner` that sends `run`, `wait` and `stop` over HTTP, and the task
  agent that executes them with `NativeTaskRunner`. `createQlever` gets a
  `remote` mode that uses it, and the search indexer image selects it with
  `QLEVER_MODE=remote`. `QLEVER_IMAGE` alone keeps meaning Docker mode.
- **The agent listens on `127.0.0.1` only, with no option to change that.**
  It runs any command it receives; inside a pod, only the pod’s own containers
  can reach it, and the pipeline can already run arbitrary code. Network
  access would need authentication and TLS, which are out of scope.
- **QLever runs as a native sidecar from the unmodified upstream image.** The
  agent is a Node single executable for glibc Linux, shipped in a small LDE
  image; an init container copies it into a shared `emptyDir` and the sidecar
  runs it as its command. The pipeline image no longer needs QLever, and a
  QLever upgrade needs no image build.
- **The executable is built from Node 24.** From Node 26, the Linux binaries
  link `libatomic`, which the Ubuntu-based QLever image does not have. A smoke
  test runs the executable in the QLever image to keep it that way.
- **The runner passes its working directory with each command**, rather than
  relying on the sidecar’s `workingDir` matching the data directory by
  convention: remote mode is native mode in another container.

## Consequences

- When QLever runs out of memory, Kubernetes restarts only the sidecar. The
  running task fails, that dataset fails, and `run()` waits up to six minutes
  for the agent to come back – longer than Kubernetes’ maximum restart
  back-off.
- The agent needs no Kubernetes permissions, and the sidecar exists only while
  the Job runs.
- Both containers must mount the data directory at the same path, and the
  sidecar needs an `exec` startup probe (`task-agent --probe`): kubelet’s
  `httpGet` and `tcpSocket` probes connect from the node to the pod’s IP
  address. Listening there instead would let anything on the cluster network
  run commands in the sidecar.
- The agent is a component LDE must maintain and keep secure.
