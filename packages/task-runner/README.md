# @lde/task-runner

Interfaces for running shell commands as tasks.

## Installation

```sh
npm install @lde/task-runner
```

```typescript
interface TaskRunner<Task> {
  run(command: string): Promise<Task>;
  wait(task: Task): Promise<string>;
  stop(task: Task): Promise<string | null>;
}
```

## Documentation

See the [full documentation](https://ldelements.org/reference/task-runner).
