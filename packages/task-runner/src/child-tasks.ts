import { constants } from 'node:os';
import process from 'node:process';

/**
 * The tasks a runner has going, which must not outlive the process that
 * started them. For implementing a task runner; a runner’s users never
 * see it.
 *
 * While any runner has tasks going, the process listens for `SIGINT` and
 * `SIGTERM` – a Ctrl-C, or a cancelled job – and on either stops every task
 * the way its runner stops one, then lets the process end as it would have
 * without the listening: with the signal’s exit status when nothing else
 * listens for the signal, and otherwise however that listener ends it. A
 * second signal while the tasks are being stopped ends the process at once,
 * so a task that will not stop does not hold the process hostage.
 *
 * Nothing listens while no task is going, so idle runners leave the process’s
 * signal handling as they found it.
 */
export class ChildTasks<Task> {
  private readonly tasks = new Set<Task>();

  /**
   * @param stop Stops one task, the way the runner’s `stop()` does. What it
   *   rejects with is dropped: the process is ending, and there is no one left
   *   to report to.
   */
  constructor(private readonly stop: (task: Task) => Promise<unknown>) {}

  /** Binds a task that has started to this process’s lifetime. */
  add(task: Task): void {
    this.tasks.add(task);
    if (this.tasks.size === 1) {
      listen(this.tasks, this.stop);
    }
  }

  /** Releases a task that has ended, whether by itself or by being stopped. */
  delete(task: Task): void {
    this.tasks.delete(task);
    if (this.tasks.size === 0) {
      unlisten(this.tasks);
    }
  }
}

/**
 * The signals that end this process on a Ctrl-C or a cancelled job. A task
 * would survive them: a native task runs in a process group of its own, a
 * container under a daemon, so neither hears what the process hears.
 */
const STOP_SIGNALS: NodeJS.Signals[] = ['SIGINT', 'SIGTERM'];

/**
 * Every runner’s going tasks, by what stops all of them. One listener for all
 * runners in the process, so it ends only once the last runner’s tasks have
 * been stopped, however many runners a signal finds busy.
 */
const stopAllOf = new Map<Set<unknown>, () => Promise<unknown>>();

function listen<Task>(
  tasks: Set<Task>,
  stop: (task: Task) => Promise<unknown>,
): void {
  if (stopAllOf.size === 0) {
    for (const signal of STOP_SIGNALS) {
      process.on(signal, onSignal);
    }
  }
  stopAllOf.set(tasks, () =>
    Promise.allSettled([...tasks].map((task) => stop(task))),
  );
}

function unlisten(tasks: Set<unknown>): void {
  stopAllOf.delete(tasks);
  if (stopAllOf.size === 0) {
    stopListening();
  }
}

function onSignal(signal: NodeJS.Signals): void {
  // Read now, while this listener is still counted: a listener that removes
  // itself when the signal arrives would otherwise be missed.
  const alone = process.listenerCount(signal) === 1;
  // Removed before the tasks are stopped, not after: the next signal then
  // finds no listener and ends the process at once, which is the way out when
  // a task does not stop.
  stopListening();
  void Promise.allSettled(
    [...stopAllOf.values()].map((stopAll) => stopAll()),
  ).then(() => {
    if (alone) {
      process.exit(128 + constants.signals[signal]);
    }
  });
}

function stopListening(): void {
  for (const signal of STOP_SIGNALS) {
    process.off(signal, onSignal);
  }
}
