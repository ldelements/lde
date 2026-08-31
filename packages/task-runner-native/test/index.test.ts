import { NativeTaskRunner } from '../src/index.js';
import { ChildProcess } from 'node:child_process';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

/**
 * Resolves once the process has closed – exited AND its output streams ended,
 * which is what 'close' waits for. Polling rather than listening for the event
 * keeps it correct whether or not the process is already gone.
 */
async function closed(task: ChildProcess): Promise<void> {
  while (task.exitCode === null || task.stdout?.readableEnded !== true) {
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  // One more turn, so the runner's own 'close' listener has run.
  await new Promise((resolve) => setTimeout(resolve, 0));
}

describe('NativeTaskRunner', () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'task-runner-native-test-'));
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  describe('constructor', () => {
    it('uses default options when none provided', () => {
      const runner = new NativeTaskRunner();
      expect(runner).toBeInstanceOf(NativeTaskRunner);
    });

    it('accepts custom working directory', () => {
      const runner = new NativeTaskRunner({ cwd: '/tmp' });
      expect(runner).toBeInstanceOf(NativeTaskRunner);
    });

    it('accepts custom graceful shutdown timeout', () => {
      const runner = new NativeTaskRunner({ gracefulShutdownTimeout: 10000 });
      expect(runner).toBeInstanceOf(NativeTaskRunner);
    });
  });

  describe('run', () => {
    it('runs a simple command', async () => {
      const runner = new NativeTaskRunner();
      const task = await runner.run('echo "hello"');
      expect(task.pid).toBeDefined();
      await runner.wait(task);
    });

    it('uses the configured working directory', async () => {
      const runner = new NativeTaskRunner({ cwd: tempDir });
      const task = await runner.run('pwd');
      const output = await runner.wait(task);
      expect(output).toContain(tempDir);
    });
  });

  describe('wait', () => {
    it('returns output on success', async () => {
      const runner = new NativeTaskRunner();
      const task = await runner.run('echo "test output"');
      const output = await runner.wait(task);
      expect(output).toContain('test output');
    });

    it('rejects on non-zero exit code', async () => {
      const runner = new NativeTaskRunner();
      const task = await runner.run('exit 1');
      await expect(runner.wait(task)).rejects.toThrow(
        'Process failed with code 1',
      );
    });

    it('returns output for a process that already succeeded', async () => {
      const runner = new NativeTaskRunner();
      const task = await runner.run('echo "test output"');
      await closed(task);

      // A pool spawns several tasks before awaiting any of them, so wait()
      // routinely arrives after the process is gone. Attaching a listener
      // then would wait for a 'close' that has already fired.
      const output = await runner.wait(task);

      expect(output).toContain('test output');
    });

    it('rejects for a process that already failed', async () => {
      const runner = new NativeTaskRunner();
      // A bad command exits within milliseconds, so a pool spawning its next
      // task is enough for this to lose the race.
      const task = await runner.run('exit 1');
      await closed(task);

      await expect(runner.wait(task)).rejects.toThrow(
        'Process failed with code 1',
      );
    });

    it('returns the same output when awaited twice', async () => {
      const runner = new NativeTaskRunner();
      const task = await runner.run('echo "test output"');

      const first = await runner.wait(task);
      const second = await runner.wait(task);

      expect(second).toBe(first);
    });

    it('settles every concurrent waiter', async () => {
      const runner = new NativeTaskRunner();
      const task = await runner.run('echo "test output"');

      // Two waiters on one task: neither may cancel the other out.
      const outputs = await Promise.all([runner.wait(task), runner.wait(task)]);

      expect(outputs[0]).toContain('test output');
      expect(outputs[1]).toBe(outputs[0]);
    });

    it('does not strand a stop() that is already in flight', async () => {
      const runner = new NativeTaskRunner();
      const task = await runner.run('sleep 60');
      await new Promise((resolve) => setTimeout(resolve, 100));

      // Aborting a run stops its tasks while their waits are outstanding.
      const stopping = runner.stop(task);
      const waiting = runner.wait(task).catch(() => 'stopped');

      await expect(Promise.all([stopping, waiting])).resolves.toBeDefined();
    });

    it('reports why a process could not be spawned', async () => {
      const runner = new NativeTaskRunner({ cwd: '/no/such/directory' });
      const task = await runner.run('echo "hello"');

      // The close code alone is -2, which says nothing about the cause.
      await expect(runner.wait(task)).rejects.toThrow('ENOENT');
    });

    it('keeps the end of a very long output', async () => {
      const runner = new NativeTaskRunner();
      const task = await runner.run(
        'for i in $(seq 1 40000); do printf "%s\n" "0123456789012345678901234567890123456789012345678901234567890123"; done; echo LAST-LINE',
      );

      const output = await runner.wait(task);

      // What a command reports about its work, it reports at the end.
      expect(output).toContain('LAST-LINE');
      expect(output.length).toBeLessThan(2_500_000);
    });

    it('rejects for a process that was already stopped', async () => {
      const runner = new NativeTaskRunner();
      const task = await runner.run('sleep 60');
      await runner.stop(task);

      await expect(runner.wait(task)).rejects.toThrow('Process failed');
    });
  });

  describe('stop', () => {
    it('stops a running process', async () => {
      const runner = new NativeTaskRunner();
      const task = await runner.run('sleep 60');

      // Give the process time to start.
      await new Promise((resolve) => setTimeout(resolve, 100));

      const output = await runner.stop(task);
      expect(output).toBeDefined();
    });

    it('returns the output of an already-exited process', async () => {
      const runner = new NativeTaskRunner();
      const task = await runner.run('echo "done"');

      // Wait for the process to complete.
      await runner.wait(task);

      // Stopping should not throw, and reading the output once must not have
      // consumed it.
      expect(await runner.stop(task)).toContain('done');
    });

    it('escalates to SIGKILL after timeout', async () => {
      const runner = new NativeTaskRunner({ gracefulShutdownTimeout: 100 });

      // Create a script that ignores SIGTERM.
      const scriptPath = join(tempDir, 'ignore-sigterm.sh');
      await writeFile(
        scriptPath,
        `#!/bin/bash
trap '' SIGTERM
while true; do sleep 1; done`,
        { mode: 0o755 },
      );

      const task = await runner.run(`bash ${scriptPath}`);

      // Give the process time to start.
      await new Promise((resolve) => setTimeout(resolve, 100));

      const startTime = Date.now();
      await runner.stop(task);
      const elapsed = Date.now() - startTime;

      // Should complete within a reasonable time after SIGKILL.
      expect(elapsed).toBeLessThan(1000);
    }, 5000);
  });
});
