import { describe, expect, it, vi } from 'vitest';
import type Docker from 'dockerode';
import type { ContainerCreateOptions } from 'dockerode';
import { DockerTaskRunner } from '../src/index.js';

type FakeDocker = Docker & {
  created: ContainerCreateOptions[];
  failNextCreate: boolean;
  failNextWait: boolean;
  stopped: number;
  pulls: number;
  /**
   * What looking up the image finds: it is there; it is missing (a 404); the
   * daemon cannot be reached (an error without a status code, as dockerode
   * gives for a refused connection); or the daemon fails (a 500).
   */
  localImage: 'present' | 'missing' | 'refused' | 'server-error';
};

/** A fake Docker daemon that records the container options passed to it. */
function createFakeDocker(): FakeDocker {
  const fake = {
    created: [] as ContainerCreateOptions[],
    stopped: 0,
    failNextCreate: false,
    failNextWait: false,
    pulls: 0,
    localImage: 'missing' as FakeDocker['localImage'],
    async pull() {
      fake.pulls++;
      return {};
    },
    getImage() {
      return {
        inspect: () => {
          switch (fake.localImage) {
            case 'present':
              return Promise.resolve({});
            case 'missing':
              return Promise.reject(
                Object.assign(new Error('no such image'), { statusCode: 404 }),
              );
            case 'refused':
              return Promise.reject(
                Object.assign(
                  new Error('connect ECONNREFUSED /var/run/docker.sock'),
                  { code: 'ECONNREFUSED' },
                ),
              );
            case 'server-error':
              return Promise.reject(
                Object.assign(new Error('server error'), { statusCode: 500 }),
              );
          }
        },
      };
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
      if (fake.failNextCreate) {
        fake.failNextCreate = false;
        throw new Error('no space left on device');
      }
      fake.created.push(options);
      return {
        start: () => Promise.resolve(),
        wait: () =>
          fake.failNextWait
            ? Promise.reject(new Error('connection reset'))
            : Promise.resolve({ StatusCode: 0 }),
        logs: () => Promise.resolve(Buffer.from('')),
        stop: () => {
          fake.stopped++;
          return Promise.resolve();
        },
      };
    },
  };
  return fake as unknown as FakeDocker;
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

  it('refuses a second task started alongside the named one', async () => {
    const docker = createFakeDocker();
    const runner = new DockerTaskRunner({
      image: 'example/image',
      containerName: 'example',
      docker,
    });

    // Overlapping calls, which is what a pool makes: both would otherwise find
    // the name free, and the second would remove the first's container.
    const results = await Promise.allSettled([
      runner.run('first'),
      runner.run('second'),
    ]);

    expect(results.map((result) => result.status)).toEqual([
      'fulfilled',
      'rejected',
    ]);
    expect(docker.created).toHaveLength(1);
  });

  it('frees the name when the task fails to start', async () => {
    const docker = createFakeDocker();
    docker.failNextCreate = true;
    const runner = new DockerTaskRunner({
      image: 'example/image',
      containerName: 'example',
      docker,
    });

    await expect(runner.run('first')).rejects.toThrow('no space left');

    // The name was claimed before the container existed; a failure to create
    // one must give it back.
    await expect(runner.run('second')).resolves.toBeDefined();
  });

  it('keeps the name when waiting fails without the container exiting', async () => {
    const docker = createFakeDocker();
    docker.failNextWait = true;
    const runner = new DockerTaskRunner({
      image: 'example/image',
      containerName: 'example',
      docker,
    });
    const task = await runner.run('first');

    await expect(runner.wait(task)).rejects.toThrow('connection reset');

    // The container is still running, so its name is still its own.
    await expect(runner.run('second')).rejects.toThrow(
      'A task is already running',
    );
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

  it('pulls the image on every run by default', async () => {
    const docker = createFakeDocker();
    docker.localImage = 'present';
    const runner = new DockerTaskRunner({ image: 'example/image', docker });

    await runner.run('first');
    await runner.run('second');

    expect(docker.pulls).toBe(2);
  });

  it('runs a local image as it is when the pull policy is missing', async () => {
    const docker = createFakeDocker();
    docker.localImage = 'present';
    const runner = new DockerTaskRunner({
      image: 'example/image',
      pullPolicy: 'missing',
      docker,
    });

    await runner.run('true');

    expect(docker.pulls).toBe(0);
    expect(docker.created).toHaveLength(1);
  });

  it('pulls an image not available locally when the pull policy is missing', async () => {
    const docker = createFakeDocker();
    docker.localImage = 'missing';
    const runner = new DockerTaskRunner({
      image: 'example/image',
      pullPolicy: 'missing',
      docker,
    });

    await runner.run('true');

    expect(docker.pulls).toBe(1);
  });

  it.each([
    ['the daemon cannot be reached', 'refused', 'ECONNREFUSED'],
    ['the daemon fails', 'server-error', 'server error'],
  ] as const)(
    'fails without pulling when looking up the image fails because %s',
    async (_reason, localImage, message) => {
      const docker = createFakeDocker();
      docker.localImage = localImage;
      const runner = new DockerTaskRunner({
        image: 'example/image',
        pullPolicy: 'missing',
        docker,
      });

      // Only a 404 says the image is missing; any other failure is reported
      // as it is, rather than answered with a pull.
      await expect(runner.run('true')).rejects.toThrow(message);
      expect(docker.pulls).toBe(0);
    },
  );

  it('never pulls when the pull policy is never', async () => {
    const docker = createFakeDocker();
    docker.localImage = 'missing';
    const runner = new DockerTaskRunner({
      image: 'example/image',
      pullPolicy: 'never',
      docker,
    });

    await runner.run('true');

    expect(docker.pulls).toBe(0);
  });

  it('stops a running container when this process is interrupted', async () => {
    const docker = createFakeDocker();
    const runner = new DockerTaskRunner({ image: 'alpine', docker });
    const exit = vi
      .spyOn(process, 'exit')
      .mockImplementation(() => undefined as never);
    const task = await runner.run('sleep 60');
    try {
      process.emit('SIGINT', 'SIGINT');

      await vi.waitFor(() => expect(exit).toHaveBeenCalledWith(130));
      expect(docker.stopped).toBe(1);
    } finally {
      vi.restoreAllMocks();
      // Ended by the signal, as far as the runner knows, so it no longer
      // listens for the next test.
      await runner.wait(task);
    }
  });
});
