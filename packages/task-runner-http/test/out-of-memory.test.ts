import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { startTaskAgent, TaskAgent } from '../agent/agent.js';
import { HttpTaskRunner } from '../src/index.js';

/**
 * The cgroup files the agent reads, by path. A real out-of-memory kill needs a
 * container with a memory limit; @lde/sparql-qlever’s remote-mode test has
 * one. Here the files are faked, so the agent’s reading of them is tested on
 * any system.
 */
const cgroupFiles = vi.hoisted(() => new Map<string, string>());

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  return {
    ...actual,
    readFile: (path: string, encoding: BufferEncoding) =>
      cgroupFiles.has(path)
        ? Promise.resolve(cgroupFiles.get(path))
        : actual.readFile(path, encoding),
  };
});

describe('the task agent on a task that ran out of memory', () => {
  let agent: TaskAgent;
  let runner: HttpTaskRunner;

  beforeEach(async () => {
    cgroupFiles.set('/sys/fs/cgroup/memory.events', 'low 0\noom_kill 3\n');
    cgroupFiles.set('/sys/fs/cgroup/memory.max', '17179869184\n');
    agent = await startTaskAgent({ port: 0 });
    runner = new HttpTaskRunner({ port: agent.port });
  });

  afterEach(async () => {
    cgroupFiles.clear();
    await agent.close();
  });

  /** Runs a command that fails, while the kernel kills `kills` processes. */
  async function failWhileKilling(kills: number): Promise<unknown> {
    const task = await runner.run('sleep 0.2; exit 137');
    cgroupFiles.set(
      '/sys/fs/cgroup/memory.events',
      `low 0\noom_kill ${3 + kills}\n`,
    );
    return runner.wait(task).catch((error: Error) => error.message);
  }

  it('puts the memory limit first', async () => {
    expect(await failWhileKilling(1)).toBe(
      'Ran out of memory: the kernel killed a process in the agent’s container at its memory limit of 16384 MiB. Process failed with code 137: ',
    );
  });

  it('leaves the limit out when the container has none', async () => {
    cgroupFiles.set('/sys/fs/cgroup/memory.max', 'max\n');
    expect(await failWhileKilling(1)).toBe(
      'Ran out of memory: the kernel killed a process in the agent’s container. Process failed with code 137: ',
    );
  });

  it('gives only the task’s failure when nothing was killed', async () => {
    expect(await failWhileKilling(0)).toBe('Process failed with code 137: ');
  });
});
