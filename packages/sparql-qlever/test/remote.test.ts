import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { copyFile, mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir, userInfo } from 'node:os';
import { join, resolve } from 'node:path';
import { ImportSuccessful } from '@lde/sparql-importer';
import { Distribution } from '@lde/dataset';
import { createQlever } from '../src/createQlever.js';

/** Built by `nx run @lde/task-runner-http:docker:build`, which test depends on. */
const agentImage = 'packages-task-runner-http';
const qleverPort = 3015;
const agentPort = 7070;
const pod = 'sparql-qlever-remote-test-pod';
const sidecar = 'sparql-qlever-remote-test-qlever';

/**
 * A pod as Kubernetes builds it: one container owns the network namespace –
 * here a forwarder that also publishes the agent’s and QLever’s ports to the
 * host, which cannot reach a container’s 127.0.0.1 otherwise – and the QLever
 * sidecar joins it, running the task agent copied in from the agent image as
 * an init container would. Both the test and the sidecar see the data
 * directory at the same path.
 */
describe('createQlever in remote mode', () => {
  let dataDir: string;
  let agentDir: string;

  beforeAll(async () => {
    dataDir = await realpath(await mkdtemp(join(tmpdir(), 'qlever-remote-')));
    agentDir = await realpath(await mkdtemp(join(tmpdir(), 'qlever-agent-')));
    removeContainers();

    docker(
      'run',
      '--rm',
      '--user',
      `${userInfo().uid}:${userInfo().gid}`,
      '--entrypoint',
      'cp',
      '-v',
      `${agentDir}:/agent`,
      agentImage,
      '/task-agent',
      '/agent/task-agent',
    );
    docker(
      'run',
      '--detach',
      '--name',
      pod,
      '-p',
      `${agentPort}:1${agentPort}`,
      '-p',
      `${qleverPort}:1${qleverPort}`,
      '--entrypoint',
      'sh',
      'alpine/socat:1.8.0.3',
      '-c',
      [agentPort, qleverPort]
        .map(
          (port) =>
            `socat TCP-LISTEN:1${port},fork,reuseaddr TCP:127.0.0.1:${port}`,
        )
        .join(' & ') + ' & wait',
    );
    docker(
      'run',
      '--detach',
      '--name',
      sidecar,
      '--network',
      `container:${pod}`,
      '--user',
      `${userInfo().uid}:${userInfo().gid}`,
      '-v',
      `${dataDir}:${dataDir}`,
      '-v',
      `${agentDir}:/agent`,
      '--entrypoint',
      '/agent/task-agent',
      process.env.QLEVER_IMAGE!,
    );
    // The startup probe a pod would have.
    await waitFor(() =>
      docker('exec', sidecar, '/agent/task-agent', '--probe'),
    );
  }, 300_000);

  afterAll(async () => {
    removeContainers();
    await rm(dataDir, { recursive: true, force: true });
    await rm(agentDir, { recursive: true, force: true });
  });

  it('imports into and serves from QLever in the sidecar', async () => {
    const dataFile = join(dataDir, 'data.ttl');
    await copyFile(resolve('test/fixtures/importer/data.ttl'), dataFile);
    const { importer, server } = createQlever({
      mode: 'remote',
      dataDir,
      port: qleverPort,
      downloader: {
        async download() {
          return { path: dataFile, headers: new Headers() };
        },
      },
    });

    const result = await importer.import([
      new Distribution(
        new URL('https://example.com/dataset/distribution'),
        'text/turtle',
      ),
    ]);
    expect(result).toBeInstanceOf(ImportSuccessful);
    expect((result as ImportSuccessful).tripleCount).toBeGreaterThan(0);

    await server.start();
    try {
      const response = await fetch(server.queryEndpoint, {
        method: 'POST',
        headers: {
          'content-type': 'application/sparql-query',
          accept: 'application/sparql-results+json',
        },
        body: 'SELECT (COUNT(*) AS ?count) WHERE { ?s ?p ?o }',
      });
      const json = (await response.json()) as {
        results: { bindings: { count: { value: string } }[] };
      };
      expect(Number(json.results.bindings[0].count.value)).toBe(
        (result as ImportSuccessful).tripleCount,
      );
    } finally {
      await server.stop();
    }
  }, 120_000);
});

function docker(...args: string[]): string {
  return execFileSync('docker', args, { encoding: 'utf8', stdio: 'pipe' });
}

function removeContainers(): void {
  try {
    docker('rm', '--force', sidecar, pod);
  } catch {
    // Not there.
  }
}

async function waitFor(check: () => unknown): Promise<void> {
  for (let attempt = 0; ; attempt++) {
    try {
      check();
      return;
    } catch (error) {
      if (attempt === 40) {
        throw error;
      }
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
  }
}
