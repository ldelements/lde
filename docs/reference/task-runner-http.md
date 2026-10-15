# @lde/task-runner-http

Run tasks in another container of the same Kubernetes pod, through a task agent that listens on `127.0.0.1`. The usual reason is memory: a sidecar has its own memory limit, so a task that runs out of memory takes down the sidecar and not the process that started it. [`@lde/sparql-qlever`](./sparql-qlever#remote-mode) uses it to run QLever this way.

The package has two halves:

- `HttpTaskRunner`, a [`TaskRunner`](./task-runner) that sends `run`, `wait` and `stop` to the agent;
- the task agent, which runs those commands with a [`NativeTaskRunner`](./task-runner-native). It ships as a single executable in `ghcr.io/ldelements/task-runner-http`, so it runs in containers that have no Node, such as the upstream QLever image.

## Installation

```sh
npm install @lde/task-runner-http
```

## Usage

```typescript
import { HttpTaskRunner } from '@lde/task-runner-http';

const runner = new HttpTaskRunner({ cwd: '/data' });

const task = await runner.run('qlever-index -i data -F nt -f data.nt');
const output = await runner.wait(task);
```

| Option | Type     | Default                     | Description                                                                                                                            |
| ------ | -------- | --------------------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| `port` | `number` | `7070`                      | Port of the agent on `127.0.0.1`.                                                                                                      |
| `cwd`  | `string` | the agent’s own working dir | Working directory for the commands, resolved to an absolute path in this process. The agent’s container must have it at the same path. |

`wait()` resolves with the command’s combined stdout and stderr, and rejects with `Process failed with code N: <output>` when it exits non-zero, as `NativeTaskRunner` does. `stop()` ends the process (`SIGTERM`, then `SIGKILL` after five seconds) and resolves with its output.

## When the agent restarts

When a task runs the sidecar out of memory, the kernel kills the container and Kubernetes restarts it. The runner handles that as follows:

- A `wait()` that is in progress rejects at once with `Lost the task agent while waiting for task <id>`, because the connection drops along with the agent.
- A `wait()` for a task the restarted agent never saw rejects too. Task IDs are random UUIDs, so a new agent on the same port never mistakes an old task for one of its own.
- `stop()` on a lost task resolves with `null`.
- `run()` keeps retrying while the agent refuses or drops the connection, for up to six minutes before it rejects. Kubernetes doubles its restart back-off up to five minutes, so the retries outlast the longest back-off. A pod without the sidecar therefore takes six minutes to fail its first task.

Each request uses a new connection. A kept-alive connection outlives an agent that restarts, and the next request on it fails as a reset instead of reaching the new agent.

While the runner has tasks going, a `SIGINT` or `SIGTERM` to this process stops them in the agent first – see [Tasks end with the process](./task-runner#tasks-end-with-the-process).

## The task agent

```sh
task-agent [--port <port>]   # listen on 127.0.0.1:<port>, default 7070
task-agent --probe [--port <port>]   # exit 0 if an agent answers, 1 if not
task-agent --version
```

The agent always listens on `127.0.0.1`, and there is no option to change that. It runs any command it receives, so the only question is who can reach it. Inside a pod, that is the other containers of the pod, and those can already run code of their own. Reaching the agent over a network would need authentication and TLS, which it does not have.

For the same reason, a kubelet `httpGet` or `tcpSocket` probe cannot reach it: those connect to the pod’s IP address. Use `--probe` in an `exec` probe instead.

The executable is built from Node 24 for glibc Linux, on amd64 and arm64. It does not run on musl (Alpine). It needs only the libraries every glibc distribution has: Node 26 and later link `libatomic` too, which the Ubuntu-based QLever image lacks.

## Kubernetes

Run the agent as a [native sidecar](https://kubernetes.io/docs/concepts/workloads/pods/sidecar-containers/), an init container with `restartPolicy: Always`. Another init container copies the executable from the LDE image into a shared `emptyDir` first. Istio and OpenTelemetry inject their agents the same way.

```yaml
apiVersion: batch/v1
kind: Job
metadata:
  name: pipeline
spec:
  template:
    spec:
      restartPolicy: Never
      # Neither container talks to the Kubernetes API.
      automountServiceAccountToken: false
      # One user for both containers, so each can read and overwrite what the
      # other writes to the data directory.
      securityContext:
        runAsUser: 1000
        runAsGroup: 1000
        fsGroup: 1000
      volumes:
        - name: data
          emptyDir: {}
        - name: task-agent
          emptyDir: {}
      initContainers:
        - name: copy-task-agent
          image: ghcr.io/ldelements/task-runner-http:<version>
          command: ['cp', '/task-agent', '/agent/task-agent']
          volumeMounts:
            - { name: task-agent, mountPath: /agent }
        - name: qlever
          image: adfreiburg/qlever:commit-<sha>
          restartPolicy: Always
          command: ['/agent/task-agent']
          startupProbe:
            exec:
              command: ['/agent/task-agent', '--probe']
            periodSeconds: 1
            failureThreshold: 30
          resources:
            limits:
              memory: 16Gi
          volumeMounts:
            - { name: task-agent, mountPath: /agent }
            - { name: data, mountPath: /data }
      containers:
        - name: pipeline
          image: <your pipeline image>
          resources:
            limits:
              memory: 2Gi
          volumeMounts:
            - { name: data, mountPath: /data }
```

Setup rules:

- Both containers mount the data directory at the same path, because the runner passes paths and its working directory to the agent as they are.
- The agent’s port (`7070`) is separate from the ports of whatever the agent runs. Both are reached on `localhost`, because containers in a pod share a network namespace.
- The startup probe holds the pipeline container back until the agent answers.
- Keep the Job’s `restartPolicy: Never`. Tasks are stopped when the pipeline process receives `SIGINT` or `SIGTERM`, but a pipeline container that is killed outright leaves them running in the sidecar. With `Never`, the pod ends and takes the sidecar with it. With `OnFailure`, the restarted pipeline would find the old `qlever-server` still holding its port.
- The sidecar exists only while the Job runs, so its memory limit counts against the namespace’s quota only during a run.
