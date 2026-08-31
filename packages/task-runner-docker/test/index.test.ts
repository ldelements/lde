import { describe, expect, it } from 'vitest';
import type Docker from 'dockerode';
import type { ContainerCreateOptions } from 'dockerode';
import { DockerTaskRunner } from '../src/index.js';

/** A fake Docker daemon that records the container options passed to it. */
function createFakeDocker(): Docker & { created: ContainerCreateOptions[] } {
  const fake = {
    created: [] as ContainerCreateOptions[],
    async pull() {
      return {};
    },
    modem: {
      followProgress(
        _stream: unknown,
        onFinished: (error: Error | null) => void,
      ) {
        onFinished(null);
      },
    },
    getContainer() {
      return {
        remove: () => Promise.resolve(),
      };
    },
    async createContainer(options: ContainerCreateOptions) {
      fake.created.push(options);
      return {
        start: () => Promise.resolve(),
        wait: () => Promise.resolve({ StatusCode: 0 }),
        logs: () => Promise.resolve(Buffer.from('')),
        stop: () => Promise.resolve(),
      };
    },
  };
  return fake as unknown as Docker & { created: ContainerCreateOptions[] };
}

describe('DockerTaskRunner', () => {
  it('publishes the port on the host when configured', async () => {
    const docker = createFakeDocker();
    const runner = new DockerTaskRunner({
      image: 'example/image',
      port: 7001,
      docker,
    });

    await runner.run('true');

    expect(docker.created[0].HostConfig?.PortBindings).toEqual({
      '7001/tcp': [{ HostPort: '7001' }],
    });
    expect(docker.created[0].HostConfig?.NetworkMode).toBeUndefined();
  });

  it('attaches the container to the configured network', async () => {
    const docker = createFakeDocker();
    const runner = new DockerTaskRunner({
      image: 'example/image',
      containerName: 'task',
      network: 'app_default',
      docker,
    });

    await runner.run('true');

    expect(docker.created[0].HostConfig?.NetworkMode).toBe('app_default');
    expect(docker.created[0].HostConfig?.PortBindings).toBeUndefined();
  });

  it('runs tasks alongside each other when they are not named', async () => {
    const docker = createFakeDocker();
    const runner = new DockerTaskRunner({ image: 'example/image', docker });

    await runner.run('first');
    await runner.run('second');

    // Docker names each container itself, so neither can displace the other.
    expect(docker.created).toHaveLength(2);
    expect(docker.created[0].name).toBeUndefined();
  });

  it('refuses a second task while the named one is still running', async () => {
    const docker = createFakeDocker();
    const runner = new DockerTaskRunner({
      image: 'example/image',
      containerName: 'example',
      docker,
    });
    await runner.run('first');

    // Starting it would have force-removed the container of the task that is
    // still running under that name.
    await expect(runner.run('second')).rejects.toThrow(
      'A task is already running as ‘example’',
    );
    expect(docker.created).toHaveLength(1);
  });

  it('reuses the name once the task it belonged to has finished', async () => {
    const docker = createFakeDocker();
    const runner = new DockerTaskRunner({
      image: 'example/image',
      containerName: 'example',
      docker,
    });

    await runner.wait(await runner.run('first'));
    await runner.stop(await runner.run('second'));
    await runner.run('third');

    // Starting a task again stays idempotent: each removes what the last left.
    expect(docker.created).toHaveLength(3);
  });
});
