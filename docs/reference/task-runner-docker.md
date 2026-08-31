# @lde/task-runner-docker

Run shell commands inside Docker containers for isolated, reproducible execution.

## Installation

```sh
npm install @lde/task-runner-docker
```

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

| Option          | Type     | Required | Description                                                                                                                        |
| --------------- | -------- | -------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| `image`         | `string` | Yes      | Docker image to use                                                                                                                |
| `containerName` | `string` | No       | Name for the container (auto-removed on restart). One task at a time; see [Naming containers](#naming-containers)                  |
| `mountDir`      | `string` | No       | Host directory to mount at `/mount` in the container                                                                               |
| `port`          | `number` | No       | Port to expose from the container                                                                                                  |
| `network`       | `string` | No       | Docker network to attach the container to (`HostConfig.NetworkMode`); on a user-defined network the container is reachable by name |
| `docker`        | `Docker` | No       | Custom Dockerode instance                                                                                                          |

## Features

- Pulls the Docker image on every `run()` call, so the container always runs the latest version of its tag
- Runs the command through a shell: the container’s entrypoint is `['sh', '-c']`, so pipelines and redirection work
- Mounts a host directory as `/mount` (also the working directory) with the `mountDir` option
- Runs commands as the current user (UID/GID) for file permissions
- Binds `port` to the **same** port number on the host and in the container
- Stops containers (without removing) so logs remain available via `docker logs`
- Removes previous containers with the same name on restart

## Output and errors

`wait()` and `stop()` do not stream logs while the container runs. Instead, each fetches the container’s stdout and stderr in one go (`follow: false`) and returns them as a string. When the container exits with a non-zero status code, `wait()` throws an error of the form `Task failed with status code N: <logs>`.

## Naming containers

`containerName` names the container, and on a `network` that name is how other containers reach it. It therefore belongs to one container at a time, and the runner enforces that: starting a task while a named task is still running is an error rather than a silent replacement.

That matters because the runner removes a container of that name before starting a task, which is what makes restarting idempotent – a container left behind by an earlier run cannot block the next one. Without the check, a second task would remove the container of the first _while it was still running_, and the first task's `wait()` would fail with no explanation of why.

Leave `containerName` unset to run tasks alongside each other. Docker then names each container itself, and nothing is shared for them to take from one another.
