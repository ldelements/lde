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

/** What {@link NativeTaskRunner} knows about a process it spawned. */
interface TaskState {
  /** Everything the process has written so far, stdout and stderr in order. */
  output: string;
  /**
   * Resolves with the exit code once the process closes, `null` when it was
   * killed by a signal. Never rejects, so nothing has to be awaited for the
   * process to stay healthy.
   */
  closed: Promise<number | null>;
}

export class NativeTaskRunner implements TaskRunner<ChildProcess> {
  private shell = true;
  private cwd?: string;
  private gracefulShutdownTimeout: number;
  /**
   * Weak, so a task's output and exit code are released along with its process
   * object, however many tasks the runner outlives.
   */
  private states = new WeakMap<ChildProcess, TaskState>();

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
    // Listen from the moment the process exists, so nothing depends on how
    // soon – or how often – the caller gets around to wait() or stop().
    const state: TaskState = {
      output: '',
      closed: new Promise((resolve) => task.once('close', resolve)),
    };
    this.states.set(task, state);

    for (const stream of [task.stdout, task.stderr]) {
      stream?.on('data', (data) => {
        state.output += data.toString();
      });
    }
    task.on('error', () => {
      // A failure to spawn arrives here, and an 'error' without a listener is
      // thrown. It also closes the process, so wait() reports it as a failure.
    });

    return task;
  }

  /** Resolves with the process's output, or rejects if it failed. */
  async wait(task: ChildProcess): Promise<string> {
    const state = this.states.get(task)!;
    const code = await state.closed;
    if (code === 0) {
      return state.output;
    }
    throw new Error(`Process failed with code ${code}: ${state.output}`);
  }

  /** Terminates the process, escalating to SIGKILL, and returns its output. */
  async stop(task: ChildProcess): Promise<string | null> {
    const state = this.states.get(task)!;
    if (task.exitCode !== null || task.killed) {
      return state.output;
    }

    try {
      // Negative PID to kill whole process group: the {shell: true} argument
      // to spawn splits off a separate process.
      process.kill(-task.pid!, 'SIGTERM');
    } catch {
      // Process may have already exited (ESRCH error).
      return state.output;
    }

    const sigkillTimer = setTimeout(() => {
      try {
        process.kill(-task.pid!, 'SIGKILL');
      } catch {
        // Process may have exited between SIGTERM and SIGKILL.
      }
    }, this.gracefulShutdownTimeout);
    try {
      await state.closed;
    } finally {
      clearTimeout(sigkillTimer);
    }

    return state.output;
  }
}
