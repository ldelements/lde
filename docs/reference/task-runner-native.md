# @lde/task-runner-native

Run shell commands natively on the host system using Node.js `child_process`.

## Installation

```sh
npm install @lde/task-runner-native
```

## Usage

```typescript
import { NativeTaskRunner } from '@lde/task-runner-native';

const runner = new NativeTaskRunner({
  cwd: '/path/to/working/dir', // Optional working directory
  gracefulShutdownTimeout: 5000, // Optional timeout before SIGKILL (default: 5000ms)
});

// Run a command
const task = await runner.run('echo "Hello World"');

// Wait for completion
const output = await runner.wait(task);
console.log(output); // "Hello World"

// Or stop a long-running task
const task2 = await runner.run('sleep 60');
await runner.stop(task2); // Sends SIGTERM, then SIGKILL after timeout
```

## Options

| Option                    | Type     | Default           | Description                                               |
| ------------------------- | -------- | ----------------- | --------------------------------------------------------- |
| `cwd`                     | `string` | Current directory | Working directory for spawned processes                   |
| `gracefulShutdownTimeout` | `number` | `5000`            | Milliseconds to wait after SIGTERM before sending SIGKILL |

## Features

- Runs commands with `shell: true`, so pipelines and redirection work
- Spawns commands in a detached process group
- Graceful shutdown with SIGTERM → SIGKILL escalation
- Handles already-exited processes in `stop()`
- Captures stdout and stderr output

## Output and errors

`wait()` resolves with the process’s combined stdout and stderr output. When the process exits with a non-zero code, it rejects with an error of the form `Process failed with code N: <output>`. Calling `stop()` on a process that has already exited resolves immediately with the buffered output.
