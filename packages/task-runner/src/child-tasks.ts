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
 * listens for the signal, and otherwise however that listener ends it. The
 * listening goes in front of any listener the process already had, so what a
 * runner’s `stop()` does before its first `await` – sending a process group
 * its `SIGTERM` – happens even when that listener ends the process at once. A
 * task started while the tasks are being stopped is stopped too, and the
 * process waits for it. A second signal while the tasks are being stopped ends
 * the process at once, so a task that will not stop does not hold the process
 * hostage.
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
    state.stopAllOf.set(this.tasks, () =>
      Promise.allSettled([...this.tasks].map((going) => this.stop(going))),
    );
    if (state.stopping) {
      // Started after the signal swept the tasks, so this one would be missed:
      // stop it here, and hold the process until that has settled.
      hold(this.stop(task));
    } else {
      listen();
    }
  }

  /** Releases a task that has ended, whether by itself or by being stopped. */
  delete(task: Task): void {
    this.tasks.delete(task);
    if (this.tasks.size === 0) {
      state.stopAllOf.delete(this.tasks);
      if (state.stopAllOf.size === 0) {
        stopListening();
      }
    }
  }
}

/**
 * The signals that end this process on a Ctrl-C or a cancelled job. A task
 * would survive them: a native task runs in a process group of its own, a
 * container under a daemon, so neither hears what the process hears.
 */
const STOP_SIGNALS: NodeJS.Signals[] = ['SIGINT', 'SIGTERM'];

interface SignalState {
  /**
   * Every runner’s going tasks, by what stops all of them. One listener for
   * all runners in the process, so it ends only once the last runner’s tasks
   * have been stopped, however many runners a signal finds busy.
   */
  readonly stopAllOf: Map<Set<unknown>, () => Promise<unknown>>;
  /** The stops that have yet to settle, which the process waits for. */
  readonly stops: Set<Promise<unknown>>;
  /** The listener registered for {@link STOP_SIGNALS}, while listening. */
  listener: ((signal: NodeJS.Signals) => void) | undefined;
  /** Whether a signal has arrived and its tasks are still being stopped. */
  stopping: boolean;
}

/**
 * Shared with any other copy of this package in the process – version skew
 * duplicates it, as it is a plain dependency – so that one signal is answered
 * once, by one listener, for every runner in the process. Two copies each
 * waiting for the other to end the process would hang instead.
 */
const SIGNAL_STATE = Symbol.for('@lde/task-runner.ChildTasks');

const globalWithState = globalThis as typeof globalThis & {
  [SIGNAL_STATE]?: SignalState;
};

const state: SignalState = (globalWithState[SIGNAL_STATE] ??= {
  stopAllOf: new Map(),
  stops: new Set(),
  listener: undefined,
  stopping: false,
});

function listen(): void {
  // Not while stopping: the listening is gone on purpose then, so a second
  // signal ends the process at once.
  if (state.listener !== undefined || state.stopping) {
    return;
  }
  state.listener = onSignal;
  for (const signal of STOP_SIGNALS) {
    // In front of any listener the process already had, so the synchronous
    // part of each stop runs even when that listener ends the process itself.
    process.prependListener(signal, onSignal);
  }
}

function stopListening(): void {
  if (state.listener === undefined) {
    return;
  }
  for (const signal of STOP_SIGNALS) {
    process.off(signal, state.listener);
  }
  state.listener = undefined;
}

function onSignal(signal: NodeJS.Signals): void {
  // Read now, while this listener is still counted: a listener that removes
  // itself when the signal arrives would otherwise be missed.
  const alone = process.listenerCount(signal) === 1;
  // Removed before the tasks are stopped, not after: the next signal then
  // finds no listener and ends the process at once, which is the way out when
  // a task does not stop.
  stopListening();
  state.stopping = true;
  for (const stopAll of state.stopAllOf.values()) {
    hold(stopAll());
  }
  void drain().then(() => {
    state.stopping = false;
    if (alone) {
      process.exit(128 + constants.signals[signal]);
    } else if (state.stopAllOf.size > 0) {
      // Another listener let the process live on, and it has tasks going
      // again: they need the same binding as the ones just stopped.
      listen();
    }
  });
}

/** Holds the process until `stop` settles, whichever way it settles. */
function hold(stop: Promise<unknown>): void {
  const settled = Promise.allSettled([stop]);
  state.stops.add(settled);
  void settled.then(() => state.stops.delete(settled));
}

/**
 * Resolves once every stop has settled – including the stops of tasks added
 * while the tasks a signal found were still being stopped.
 */
async function drain(): Promise<void> {
  while (state.stops.size > 0) {
    await Promise.all([...state.stops]);
  }
}
