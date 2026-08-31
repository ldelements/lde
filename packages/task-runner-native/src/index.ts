import { TaskRunner } from '@lde/task-runner';
import { ChildProcess, spawn } from 'node:child_process';
import process from 'node:process';

/**
 * Characters of output kept per task. A server task runs for as long as the
 * pipeline does, so its log would otherwise grow without bound. The *last*
 * characters are the ones kept: what a command reports about its work – a
 * failure, or the metadata it prints when it is done – it prints at the end.
 */
const maxOutputLength = 1_000_000;

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
  /**
   * What the process has written, stdout and stderr in order, truncated to the
   * last {@link maxOutputLength} characters.
   */
  output: string;
  /**
   * Why the process could not be spawned at all, if it could not: an
   * unreadable `cwd`, say. The close code alone (`-2`) does not say.
   */
  error?: Error;
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
      // Decode across chunk boundaries: a multi-byte character split over two
      // chunks would otherwise become replacement characters.
      stream?.setEncoding('utf8');
      stream?.on('data', (chunk: string) => {
        state.output += chunk;
        if (state.output.length > 2 * maxOutputLength) {
          state.output = state.output.slice(-maxOutputLength);
        }
      });
    }
    task.on('error', (error) => {
      // A failure to spawn arrives here, and an 'error' without a listener is
      // thrown. It also closes the process, so wait() reports it as a failure.
      state.error = error;
    });

    return task;
  }

  /** Resolves with the process's output, or rejects if it failed. */
  async wait(task: ChildProcess): Promise<string> {
    const state = this.states.get(task)!;
    const code = await state.closed;
    if (code === 0) {
      return this.outputOf(state);
    }
    throw new Error(
      `Process failed with code ${code}: ${this.outputOf(state)}`,
    );
  }

  /** Terminates the process, escalating to SIGKILL, and returns its output. */
  async stop(task: ChildProcess): Promise<string | null> {
    const state = this.states.get(task)!;
    const sigkillTimer = this.terminate(task);
    try {
      // 'exit' fires before 'close', so only awaiting the close guarantees the
      // output is complete – including for a process that was already going.
      await state.closed;
    } finally {
      clearTimeout(sigkillTimer);
    }

    return this.outputOf(state);
  }

  /**
   * Asks a still-running process to terminate, and returns the timer that
   * escalates to SIGKILL if it does not.
   */
  private terminate(
    task: ChildProcess,
  ): ReturnType<typeof setTimeout> | undefined {
    if (task.exitCode !== null || task.killed) {
      return undefined;
    }
    try {
      // Negative PID to kill whole process group: the {shell: true} argument
      // to spawn splits off a separate process.
      process.kill(-task.pid!, 'SIGTERM');
    } catch {
      // Process may have already exited (ESRCH error).
      return undefined;
    }

    return setTimeout(() => {
      try {
        process.kill(-task.pid!, 'SIGKILL');
      } catch {
        // Process may have exited between SIGTERM and SIGKILL.
      }
    }, this.gracefulShutdownTimeout);
  }

  /** The process's output, prefixed by why it could not be spawned at all. */
  private outputOf(state: TaskState): string {
    return state.error === undefined
      ? state.output
      : `${state.error.message}: ${state.output}`;
  }
}
