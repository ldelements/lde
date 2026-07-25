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
