# @lde/task-runner-native

Run shell commands natively on the host system using Node.js `child_process`.

## Installation

```sh
npm install @lde/task-runner-native
```

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
```

## Documentation

See the [full documentation](https://ldelements.org/reference/task-runner-native).
