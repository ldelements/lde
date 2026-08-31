import process from 'node:process';
import { TaskRunner } from '@lde/task-runner';
import Docker, { Container, ContainerCreateOptions } from 'dockerode';

export interface DockerTaskRunnerOptions {
  image: string;
  /**
   * Name for the container. Other containers on a `network` address it by this
   * name, so it belongs to one container at a time: a runner that has it runs
   * one task at a time, and rejects a second while the first is still going.
   * Leave it unset to run tasks alongside each other, and Docker names each
   * container itself.
   */
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
  /**
   * What holds {@link DockerTaskRunnerOptions.containerName}: the container
   * running under it, or `'starting'` while one is being created, so a second
   * task cannot take the name out from under one that is still running.
   *
   * Claimed before the first await in {@link run}, because two calls that
   * overlap would otherwise both find it free.
   */
  private nameHolder?: Container | 'starting';

  constructor(options: DockerTaskRunnerOptions) {
    this.options = {
      docker: new Docker(),
      ...options,
    };
  }

  async wait(task: Container): Promise<string> {
    // Only once the container has exited: a wait() that fails for a reason of
    // its own – a dropped connection, say – leaves it running, and freeing the
    // name would let the next task remove a container still doing its work.
    const result = await task.wait();
    this.releaseName(task);

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
      if (this.nameHolder !== undefined) {
        throw new Error(
          `A task is already running as ‘${this.options.containerName}’. A runner with a containerName runs one task at a time, because that name is how other containers address it; leave containerName unset to run tasks alongside each other.`,
        );
      }
      // Before anything is awaited, so two overlapping calls cannot both take
      // the name for themselves.
      this.nameHolder = 'starting';
    }
    try {
      return await this.start(command);
    } catch (error) {
      if (this.nameHolder === 'starting') {
        this.nameHolder = undefined;
      }
      throw error;
    }
  }

  /** Creates and starts the container for `command`. */
  private async start(command: string): Promise<Container> {
    if (this.options.containerName) {
      try {
        // A container of this name left behind by an earlier run: removing it
        // is what makes starting a task again idempotent.
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
    if (this.options.containerName) {
      this.nameHolder = container;
    }

    return container;
  }

  /** Frees the container name, once the task holding it is no longer running. */
  private releaseName(task: Container): void {
    if (this.nameHolder === task) {
      this.nameHolder = undefined;
    }
  }

  async stop(task: Container): Promise<string> {
    try {
      await task.stop();
    } catch (error) {
      // 304 says it had already stopped, which is the state being asked for.
      if ((error as { statusCode?: number }).statusCode !== 304) {
        throw error;
      }
    }
    // Only now: a stop that did not happen leaves the container running, and
    // its name is still its own.
    this.releaseName(task);

    const logs = await task.logs({
      stdout: true,
      stderr: true,
      follow: false,
    });
    return logs.toString();
  }
}
