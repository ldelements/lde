import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, realpath, rm } from 'node:fs/promises';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startTaskAgent, TaskAgent } from '../agent/agent.js';
import { HttpTaskRunner } from '../src/index.js';

describe('HttpTaskRunner', () => {
  let agent: TaskAgent;
  let runner: HttpTaskRunner;

  beforeEach(async () => {
    agent = await startTaskAgent({ port: 0 });
    runner = new HttpTaskRunner({ port: agent.port });
  });

  afterEach(async () => {
    await agent.close();
  });

  it('answers health checks', async () => {
    const response = await fetch(`http://127.0.0.1:${agent.port}/health`);
    expect(response.status).toBe(204);
  });

  it('resolves with the output of a command that succeeds', async () => {
    const task = await runner.run('echo hello');
    expect(await runner.wait(task)).toBe('hello\n');
  });

  it('rejects with the output of a command that fails', async () => {
    const task = await runner.run('echo oops >&2; exit 3');
    await expect(runner.wait(task)).rejects.toThrow(
      'Process failed with code 3: oops',
    );
  });

  it('runs the command in the working directory it is given', async () => {
    const directory = await realpath(
      await mkdtemp(join(tmpdir(), 'task-runner-http-test-')),
    );
    try {
      const inDirectory = new HttpTaskRunner({
        port: agent.port,
        cwd: directory,
      });
      const task = await inDirectory.run('pwd');
      expect(await inDirectory.wait(task)).toBe(`${directory}\n`);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it('stops a long-running command and resolves with its output', async () => {
    const task = await runner.run('echo started; sleep 60');
    // Let the command write before it is stopped.
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(await runner.stop(task)).toBe('started\n');
  });

  it('forgets a task once it has been waited for', async () => {
    const task = await runner.run('true');
    await runner.wait(task);
    expect(await runner.stop(task)).toBeNull();
  });

  it('resolves stop() with null when the agent is gone', async () => {
    const task = await runner.run('sleep 60');
    await runner.stop(task);
    await agent.close();
    expect(await runner.stop(task)).toBeNull();
    agent = await startTaskAgent({ port: 0 });
  });

  it('rejects wait() for a task the agent does not know', async () => {
    const lost = { id: 'from-before-a-restart' };
    await expect(runner.wait(lost)).rejects.toThrow(
      'is unknown to the task agent, which must have restarted',
    );
  });

  it('rejects wait() promptly when the agent goes away', async () => {
    const task = await runner.run('sleep 60');
    const waiting = runner.wait(task);
    await agent.close();
    await expect(waiting).rejects.toThrow(
      `Lost the task agent while waiting for task ${task.id}`,
    );
    agent = await startTaskAgent({ port: 0 });
  });

  it('rejects wait() when the agent is unreachable', async () => {
    await agent.close();
    await expect(runner.wait({ id: 'any' })).rejects.toThrow(
      'Lost the task agent while waiting for task any',
    );
    agent = await startTaskAgent({ port: 0 });
  });

  it('waits for an agent that is not up yet', async () => {
    const port = agent.port;
    await agent.close();
    const running = runner.run('echo late');
    setTimeout(async () => {
      agent = await startTaskAgent({ port });
    }, 1500);
    expect(await runner.wait(await running)).toBe('late\n');
  });

  it('retries a run the agent dropped, and reports a failed wait', async () => {
    let requests = 0;
    // An agent that goes away while answering its first request, then fails
    // the wait it is asked for.
    const flaky = createServer((request, response) => {
      requests++;
      if (requests === 1) {
        request.socket.destroy();
      } else if (request.method === 'POST' && request.url === '/tasks') {
        response.writeHead(201).end(JSON.stringify({ id: 'flaky' }));
      } else {
        response.writeHead(500).end(JSON.stringify({ message: 'boom' }));
      }
    });
    await new Promise<void>((resolve) => flaky.listen(0, '127.0.0.1', resolve));
    try {
      const port = (flaky.address() as AddressInfo).port;
      const flakyRunner = new HttpTaskRunner({ port });
      const task = await flakyRunner.run('true');
      expect(task.id).toBe('flaky');
      await expect(flakyRunner.wait(task)).rejects.toThrow(
        'The task agent failed to wait for task flaky (HTTP 500): {"message":"boom"}',
      );
    } finally {
      flaky.close();
    }
  });

  it('gives up on an agent that does not come up', async () => {
    await agent.close();
    vi.useFakeTimers({ toFake: ['setTimeout', 'Date'] });
    try {
      const running = runner.run('true');
      const rejected = expect(running).rejects.toThrow(/ECONNREFUSED/);
      // Each attempt fails on a real connection, then waits a fake second.
      for (let minute = 0; minute < 7 * 60; minute++) {
        await vi.advanceTimersByTimeAsync(1000);
        await new Promise((resolve) => setImmediate(resolve));
      }
      await rejected;
    } finally {
      vi.useRealTimers();
      agent = await startTaskAgent({ port: 0 });
    }
  });

  it('stops its tasks in the agent when this process is interrupted', async () => {
    const exit = vi
      .spyOn(process, 'exit')
      .mockImplementation(() => undefined as never);
    try {
      const task = await runner.run('sleep 60');
      process.emit('SIGTERM', 'SIGTERM');
      await vi.waitFor(() => expect(exit).toHaveBeenCalledWith(143));
      // The agent forgets a task once it has stopped it at the runner’s
      // request; had only the agent’s own runner stopped it, wait() would
      // report the process’s exit instead.
      await expect(runner.wait(task)).rejects.toThrow(
        'is unknown to the task agent',
      );
    } finally {
      vi.restoreAllMocks();
    }
  });
});
