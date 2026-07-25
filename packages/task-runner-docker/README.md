# @lde/task-runner-docker

Run shell commands inside Docker containers for isolated, reproducible execution.

## Installation

```sh
npm install @lde/task-runner-docker
```

```typescript
import { DockerTaskRunner } from '@lde/task-runner-docker';

const runner = new DockerTaskRunner({
  image: 'ubuntu:latest',
  containerName: 'my-task', // Optional container name
  mountDir: '/path/to/data', // Optional directory to mount at /mount
  port: 8080, // Optional port to expose
});

// Run a command in the container
const container = await runner.run('ls -la /mount');

// Wait for completion
const output = await runner.wait(container);
console.log(output);
```

## Documentation

See the [full documentation](https://ldelements.org/reference/task-runner-docker).
