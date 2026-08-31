import { NativeTaskRunner } from '../src/index.js';
import { ChildProcess } from 'node:child_process';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

/** Resolves once the process has exited and its output has been read. */
function closed(task: ChildProcess): Promise<void> {
  return new Promise((resolve) => {
    if (task.exitCode !== null || task.signalCode !== null) {
      // Still give the 'close' listeners a turn to run.
      setImmediate(resolve);
      return;
    }
    task.on('close', () => setImmediate(resolve));
  });
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

    it('handles already-exited processes', async () => {
      const runner = new NativeTaskRunner();
      const task = await runner.run('echo "done"');

      // Wait for the process to complete.
      await runner.wait(task);

      // Stopping should not throw.
      const output = await runner.stop(task);
      expect(output).toBeDefined();
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
