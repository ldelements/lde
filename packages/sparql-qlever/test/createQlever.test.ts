import { resolve } from 'node:path';
import { DockerTaskRunner } from '@lde/task-runner-docker';
import { LastModifiedDownloader } from '@lde/distribution-downloader';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createQlever } from '../src/createQlever.js';

vi.mock('@lde/task-runner-docker', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('@lde/task-runner-docker')>();
  return {
    ...actual,
    DockerTaskRunner: vi.fn(function (
      options: ConstructorParameters<typeof actual.DockerTaskRunner>[0],
    ) {
      return new actual.DockerTaskRunner(options);
    }),
  };
});

vi.mock('@lde/distribution-downloader', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('@lde/distribution-downloader')>();
  return {
    ...actual,
    LastModifiedDownloader: vi.fn(function (path?: string) {
      return new actual.LastModifiedDownloader(path);
    }),
  };
});

beforeEach(() => {
  vi.mocked(DockerTaskRunner).mockClear();
  vi.mocked(LastModifiedDownloader).mockClear();
});

describe('createQlever', () => {
  it('addresses the endpoint as localhost by default', () => {
    const { server } = createQlever({
      mode: 'docker',
      image: 'adfreiburg/qlever:latest',
      dataDir: '/data',
    });
    expect(server.queryEndpoint.toString()).toBe(
      'http://localhost:7001/sparql',
    );
  });

  it('addresses the endpoint as localhost in native mode', () => {
    const { server } = createQlever({ mode: 'native', port: 7002 });
    expect(server.queryEndpoint.toString()).toBe(
      'http://localhost:7002/sparql',
    );
  });

  it('addresses the endpoint by container name on a Docker network', () => {
    const { server } = createQlever({
      mode: 'docker',
      image: 'adfreiburg/qlever:latest',
      network: 'app_default',
      containerName: 'qlever',
      dataDir: '/data',
    });
    expect(server.queryEndpoint.toString()).toBe('http://qlever:7001/sparql');
  });

  it('rejects a network without a container name at the type level', () => {
    // @ts-expect-error network requires containerName, the endpoint hostname
    createQlever({
      mode: 'docker',
      image: 'adfreiburg/qlever:latest',
      dataDir: '/data',
      network: 'app_default',
    });
  });

  it('rejects docker mode without a data directory', () => {
    expect(() =>
      // @ts-expect-error docker mode requires dataDir, the directory it bind-mounts
      createQlever({
        mode: 'docker',
        image: 'adfreiburg/qlever:latest',
      }),
    ).toThrow('dataDir is required for QLever docker mode');
  });

  it('mounts and downloads into the same absolute path for a relative dataDir', () => {
    createQlever({
      mode: 'docker',
      image: 'adfreiburg/qlever:latest',
      dataDir: './data',
    });
    expect(DockerTaskRunner).toHaveBeenCalledWith(
      expect.objectContaining({ mountDir: resolve('data') }),
    );
    expect(LastModifiedDownloader).toHaveBeenCalledWith(resolve('data'));
  });

  it('rejects docker mode with an empty data directory', () => {
    expect(() =>
      createQlever({
        mode: 'docker',
        image: 'adfreiburg/qlever:latest',
        dataDir: '',
      }),
    ).toThrow('dataDir is required for QLever docker mode');
  });
});
