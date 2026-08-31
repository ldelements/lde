import { TaskRunner } from '@lde/task-runner';
import { ChildProcess, spawn } from 'node:child_process';
import process from 'node:process';

export interface NativeTaskRunnerOptions {
  /**
   * Working directory for spawned processes.
   * Defaults to the current working directory.
   */
  cwd?: string;
  /**
   * Timeout in milliseconds to wait for graceful shutdown (SIGTERM)
   * before escalating to SIGKILL.
   * @default 5000
   */
  gracefulShutdownTimeout?: number;
}

/** What a process left behind once it closed. */
interface TaskResult {
  /** Exit code, or `null` when the process was killed by a signal. */
  code: number | null;
  /** Output, when the failure path already read (and so consumed) it. */
  output?: string;
}

export class NativeTaskRunner implements TaskRunner<ChildProcess> {
  private stdout: Map<number, string> = new Map();
  private stderr: Map<number, string> = new Map();
  private shell = true;
  private cwd?: string;
  private gracefulShutdownTimeout: number;
  /**
   * Results of processes that have already closed, so {@link wait} can settle
   * for one that finished before it was called. Weak, so a task nobody waits
   * on is forgotten along with its process object.
   */
  private results = new WeakMap<ChildProcess, TaskResult>();

  constructor(options?: NativeTaskRunnerOptions) {
    this.cwd = options?.cwd;
    this.gracefulShutdownTimeout = options?.gracefulShutdownTimeout ?? 5000;
  }

  async run(command: string): Promise<ChildProcess> {
    const task = spawn(command, {
      detached: true,
      shell: this.shell,
      cwd: this.cwd,
    });

    task.on('close', (code: number | null) => {
      /** code is null when the process was killed, which is expected when
       * {@link stop} is called. */
      if (code !== null && code !== 0) {
        // Reading the output here consumes it, so keep it for a later wait().
        const output = this.taskOutput(task);
        this.results.set(task, { code, output });
        task.emit('error', new Error(output));
      } else {
        // Leave the output unread: stop() still has to be able to return it.
        this.results.set(task, { code });
      }
    });
    task.on('error', () => {
      // Handled by wait(); listener prevents 'unhandled error' crashes.
    });

    if (task.pid !== undefined) {
      task.stdout.on('data', (data) => {
        this.stdout.set(
          task.pid!,
          (this.stdout.get(task.pid!) ?? '') + data.toString(),
        );
      });

      task.stderr.on('data', (data) => {
        this.stderr.set(
          task.pid!,
          (this.stderr.get(task.pid!) ?? '') + data.toString(),
        );
      });
    }

    return task;
  }

  /**
   * Resolves with the process's output, or rejects if it failed – whether it
   * is still running or has already closed. A pool spawns several tasks before
   * awaiting any of them, so a task that fails fast (a bad jar path exits in
   * milliseconds) routinely closes before wait() is called.
   */
  async wait(task: ChildProcess): Promise<string> {
    const result = this.results.get(task) ?? (await this.closed(task));
    const output = result.output ?? this.taskOutput(task);
    if (result.code === 0) {
      return output;
    }
    throw new Error(`Process failed with code ${result.code}: ${output}`);
  }

  /** Resolves once `task` closes, recording what it left behind. */
  private closed(task: ChildProcess): Promise<TaskResult> {
    return new Promise((resolve) => {
      // When waiting for a task, reject on error instead of crashing the
      // process, as we do on purpose in the close listener in run().
      task.removeAllListeners('close');
      task.on('close', (code: number | null) => {
        const result = { code };
        this.results.set(task, result);
        resolve(result);
      });
    });
  }

  async stop(task: ChildProcess): Promise<string | null> {
    return new Promise((resolve) => {
      // Handle already-exited processes.
      if (task.exitCode !== null || task.killed) {
        resolve(this.taskOutput(task));
        return;
      }

      const sigkillTimer: { current?: ReturnType<typeof setTimeout> } = {};

      const cleanup = () => {
        if (sigkillTimer.current) {
          clearTimeout(sigkillTimer.current);
        }
        resolve(this.taskOutput(task));
      };

      task.on('close', cleanup);

      // Negative PID to kill whole process group: the {shell: true} argument
      // to spawn splits off a separate process.
      try {
        process.kill(-task.pid!, 'SIGTERM');
      } catch {
        // Process may have already exited (ESRCH error).
        cleanup();
        return;
      }

      // Escalate to SIGKILL after timeout if process doesn't terminate.
      sigkillTimer.current = setTimeout(() => {
        try {
          process.kill(-task.pid!, 'SIGKILL');
        } catch {
          // Process may have exited between SIGTERM and SIGKILL.
        }
      }, this.gracefulShutdownTimeout);
    });
  }

  private taskOutput(task: ChildProcess) {
    const output =
      (this.stdout.get(task.pid!) ?? '') + (this.stderr.get(task.pid!) ?? '');
    this.stdout.delete(task.pid!);
    this.stderr.delete(task.pid!);

    return output;
  }
}
