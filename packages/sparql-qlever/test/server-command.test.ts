import { describe, it, expect, vi } from 'vitest';
import type { TaskRunner } from '@lde/task-runner';

vi.mock('@lde/wait-for-sparql', () => ({
  waitForSparqlEndpointAvailable: vi.fn(),
}));

// Import Server after the mock is set up.
const { Server } = await import('../src/server.js');

/** A fake task runner that records the command passed to `run()`. */
function createMockTaskRunner(): TaskRunner<string> & {
  lastCommand: string | undefined;
} {
  const mock = {
    lastCommand: undefined as string | undefined,
    async run(command: string) {
      mock.lastCommand = command;
      return command;
    },
    async wait() {
      return '';
    },
    async stop() {
      return null;
    },
  };
  return mock;
}

describe('Server command construction', () => {
  it('does not include --cache-max-size when option is not set', async () => {
    const taskRunner = createMockTaskRunner();
    const server = new Server({
      taskRunner,
      indexName: 'test-index',
      port: 7001,
    });

    await server.start();
    expect(taskRunner.lastCommand).not.toContain('--cache-max-size');
  });

  it('includes --cache-max-size when option is set', async () => {
    const taskRunner = createMockTaskRunner();
    const server = new Server({
      taskRunner,
      indexName: 'test-index',
      port: 7001,
      qleverOptions: { 'cache-max-size': '5G' },
    });

    await server.start();
    expect(taskRunner.lastCommand).toContain('--cache-max-size 5G');
  });

  it('includes --construct-deduplication only when option is set', async () => {
    const withoutOption = createMockTaskRunner();
    await new Server({
      taskRunner: withoutOption,
      indexName: 'test-index',
    }).start();
    expect(withoutOption.lastCommand).not.toContain(
      '--construct-deduplication',
    );

    const withOption = createMockTaskRunner();
    await new Server({
      taskRunner: withOption,
      indexName: 'test-index',
      qleverOptions: { 'construct-deduplication': 'lru:10000' },
    }).start();
    expect(withOption.lastCommand).toContain(
      '--construct-deduplication lru:10000',
    );
  });
});
