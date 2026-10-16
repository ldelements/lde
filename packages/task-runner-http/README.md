# @lde/task-runner-http

Run tasks in another container of the same pod, such as a sidecar with its own image and memory limit, through a task agent that listens on `127.0.0.1`. The agent ships as a single executable in `ghcr.io/ldelements/task-runner-http`.

## Installation

```sh
npm install @lde/task-runner-http
```

```typescript
import { HttpTaskRunner } from '@lde/task-runner-http';

const runner = new HttpTaskRunner({ cwd: '/data' });
const output = await runner.wait(await runner.run('ls'));
```

## Documentation

See the [full documentation](https://ldelements.org/reference/task-runner-http).
