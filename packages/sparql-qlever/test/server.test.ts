import { describe, it, expect } from 'vitest';
import { Server } from '../src/server.js';
import { DockerTaskRunner } from '@lde/task-runner-docker';
import { resolve } from 'node:path';

describe('Server', () => {
  describe('start', () => {
    it('starts QLever, deduplicating CONSTRUCT results, and stops it', async () => {
      const port = 7001;
      const taskRunner = new DockerTaskRunner({
        image: process.env.QLEVER_IMAGE!,
        containerName: 'qlever-server-test',
        mountDir: resolve('test/fixtures/server'),
        port,
      });

      const server = new Server({
        taskRunner,
        indexName: 'test-index',
        port,
        qleverOptions: { 'construct-deduplication': 'full' },
      });

      await server.start();
      expect(server.queryEndpoint.toString()).toEqual(
        `http://localhost:${port}/sparql`,
      );

      // Three solutions instantiate the same triple, which QLever emits once.
      const response = await fetch(server.queryEndpoint, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/sparql-query',
          Accept: 'application/n-triples',
        },
        body: 'CONSTRUCT { <http://example.com/s> <http://example.com/p> <http://example.com/o> } WHERE { VALUES ?x { 1 2 3 } }',
      });
      const triples = (await response.text()).trim().split('\n');
      expect(triples).toHaveLength(1);

      await server.stop();
    }, 120_000);
  });
});
