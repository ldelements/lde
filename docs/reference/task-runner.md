# @lde/task-runner

Interfaces for running shell commands as tasks. Implementations run commands:

- [in Docker containers](./task-runner-docker) – isolated environment
- [natively on the host](./task-runner-native) – direct execution

## Installation

```sh
npm install @lde/task-runner
```

## TaskRunner Interface

```typescript
interface TaskRunner<Task> {
  run(command: string): Promise<Task>;
  wait(task: Task): Promise<string>;
  stop(task: Task): Promise<string | null>;
}
```

- `run(command)` – Start a shell command, returns a task handle
- `wait(task)` – Wait for completion, returns stdout/stderr output
- `stop(task)` – Stop the task, returns output collected so far

## Tasks end with the process

A task would outlive the process that started it: a native task runs in a process group of its own, so a Ctrl-C does not reach it, and a container runs under the Docker daemon, which hears nothing of the process at all. So while any runner has a task going, the process listens for `SIGINT` and `SIGTERM` – a Ctrl-C, or a cancelled CI job – and on either stops every task the way `stop()` does, then ends the process as it would have without the listening: with the signal’s exit status (`130` for `SIGINT`, `143` for `SIGTERM`), unless the process has a listener of its own for the signal, in which case that listener decides how the process ends. A second signal while the tasks are being stopped ends the process at once, so a task that does not stop cannot hold it hostage.

Nothing listens while no task is going, so an idle runner leaves the process’s signal handling as it found it. The same mechanism is available to other runner implementations as `LiveTasks`: `add()` a task once it has started, `delete()` it once it has ended, and pass what stops one to the constructor.
