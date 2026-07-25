# Task Runner Docker

Run shell commands inside Docker containers for isolated, reproducible execution.

## Usage

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

// Or stop a running container
await runner.stop(container);
```

## Options

| Option          | Type     | Required | Description                                          |
| --------------- | -------- | -------- | ---------------------------------------------------- |
| `image`         | `string` | Yes      | Docker image to use                                  |
| `containerName` | `string` | No       | Name for the container (auto-removed on restart)     |
| `mountDir`      | `string` | No       | Host directory to mount at `/mount` in the container |
| `port`          | `number` | No       | Container port to publish on the same host port      |
| `network`       | `string` | No       | Docker network to attach the container to            |
| `docker`        | `Docker` | No       | Custom Dockerode instance                            |

## Features

- Automatically pulls the Docker image before running
- Mounts a host directory as `/mount` with the `mountDir` option
- Runs commands as the current user (UID/GID) for file permissions
- Publishes ports on the host with the `port` option
- Attaches the container to a Docker network with the `network` option, where
  other containers reach it by its `containerName` as hostname
- Stops containers (without removing) so logs remain available via `docker logs`
- Removes previous containers with the same name on restart
- Streams container logs to stdout
