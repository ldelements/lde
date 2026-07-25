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
});
