import process from 'node:process';
import { TaskRunner } from '@lde/task-runner';
import Docker, { Container, ContainerCreateOptions } from 'dockerode';

export interface DockerTaskRunnerOptions {
  image: string;
  containerName?: string;
  /** Publish this container port to the same port on the host. */
  port?: number;
  mountDir?: string;
  /**
   * Docker network to attach the container to. On a user-defined network,
   * other containers reach it by its `containerName` as hostname, so
   * publishing a host `port` becomes unnecessary.
   */
  network?: string;
  docker?: Docker;
}

export class DockerTaskRunner implements TaskRunner<Container> {
  private readonly options;

  constructor(options: DockerTaskRunnerOptions) {
    this.options = {
      docker: new Docker(),
      ...options,
    };
  }

  async wait(task: Container): Promise<string> {
    const result = await task.wait();
    const logs = (
      await task.logs({
        stdout: true,
        stderr: true,
        follow: false,
      })
    ).toString();

    if (result.StatusCode !== 0) {
      throw new Error(
        `Task failed with status code ${result.StatusCode}: ${logs})`,
      );
    }

    return logs;
  }

  async run(command: string): Promise<Container> {
    if (this.options.containerName) {
      try {
        await this.options.docker
          .getContainer(this.options.containerName)
          .remove({ force: true });
      } catch {
        // Ignore if the container does not exist yet.
      }
    }

    const pull = await this.options.docker.pull(this.options.image);
    const err = await new Promise<Error | null>((resolve) =>
      this.options.docker.modem.followProgress(pull, resolve),
    );
    if (err) {
      throw err;
    }

    const containerOptions: ContainerCreateOptions = {
      Entrypoint: ['sh', '-c'],
      Image: this.options.image,
      Cmd: [command],
      name: this.options.containerName,
      User: `${process.getuid!()}:${process.getgid!()}`,
    };

    if (this.options.port) {
      containerOptions.ExposedPorts = {
        [`${this.options.port}/tcp`]: {},
      };
      containerOptions.HostConfig = {
        PortBindings: {
          [`${this.options.port}/tcp`]: [
            {
              HostPort: this.options.port.toString(),
            },
          ],
        },
      };
    }

    if (this.options.network) {
      containerOptions.HostConfig = {
        ...containerOptions.HostConfig,
        NetworkMode: this.options.network,
      };
    }

    if (this.options.mountDir) {
      containerOptions.HostConfig = {
        ...containerOptions.HostConfig,
        Binds: [`${this.options.mountDir}:/mount`],
      };
      containerOptions.WorkingDir = '/mount';
    }

    const container =
      await this.options.docker.createContainer(containerOptions);

    await container.start();

    return container;
  }

  async stop(task: Container): Promise<string> {
    const logs = await task.logs({
      stdout: true,
      stderr: true,
      follow: false,
    });
    await task.stop();
    return logs.toString();
  }
}
