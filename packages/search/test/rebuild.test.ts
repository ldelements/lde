import { describe, expect, it } from 'vitest';
import { RebuildAlreadyRunning, requestRebuild } from '../src/index.js';
import type { RebuildRequests } from '../src/adapter.js';

/** Rebuild requests held in memory, numbered so each record is a new value. */
function memoryRequests(): RebuildRequests {
  let count = 0;
  let latest: string | undefined;
  return {
    record: async () => {
      count++;
      latest = `request-${count}`;
    },
    latest: async () => latest,
  };
}

/** A single-flight lock the way an engine port’s writer holds one: a run
 *  that finds it held throws {@link RebuildAlreadyRunning}. */
function lockedRebuild(body: () => Promise<void>): {
  rebuild: () => Promise<void>;
  runs: () => number;
} {
  let held = false;
  let runs = 0;
  return {
    rebuild: async () => {
      if (held) {
        throw new RebuildAlreadyRunning('datasets');
      }
      held = true;
      runs++;
      try {
        await body();
      } finally {
        held = false;
      }
    },
    runs: () => runs,
  };
}

/** A promise with its resolver, to hold a run open until the test lets go. */
function gate(): { opened: Promise<void>; open: () => void } {
  let open!: () => void;
  const opened = new Promise<void>((resolve) => {
    open = resolve;
  });
  return { opened, open };
}

describe('requestRebuild', () => {
  it('runs the rebuild once when no request arrives during the run', async () => {
    const { rebuild, runs } = lockedRebuild(async () => undefined);

    await requestRebuild(rebuild, memoryRequests());

    expect(runs()).toBe(1);
  });

  it('runs again when a request is recorded during the run', async () => {
    const requests = memoryRequests();
    let first = true;
    const { rebuild, runs } = lockedRebuild(async () => {
      if (first) {
        first = false;
        await requests.record();
      }
    });

    await requestRebuild(rebuild, requests);

    expect(runs()).toBe(2);
  });

  it('hands the request to the run holding the lock, which runs again for it', async () => {
    const requests = memoryRequests();
    const held = gate();
    const started = gate();
    let first = true;
    const { rebuild, runs } = lockedRebuild(async () => {
      if (first) {
        first = false;
        started.open();
        await held.opened;
      }
    });

    const holder = requestRebuild(rebuild, requests);
    await started.opened;
    // The second request finds the lock held and returns without a run of its
    // own; the holder sees its request once its own run is done.
    await requestRebuild(rebuild, requests);
    expect(runs()).toBe(1);

    held.open();
    await holder;
    expect(runs()).toBe(2);
  });

  it('serves a burst of requests during one run with a single rerun', async () => {
    const requests = memoryRequests();
    const held = gate();
    const started = gate();
    let first = true;
    const { rebuild, runs } = lockedRebuild(async () => {
      if (first) {
        first = false;
        started.open();
        await held.opened;
      }
    });

    const holder = requestRebuild(rebuild, requests);
    await started.opened;
    await Promise.all([
      requestRebuild(rebuild, requests),
      requestRebuild(rebuild, requests),
      requestRebuild(rebuild, requests),
    ]);

    held.open();
    await holder;
    expect(runs()).toBe(2);
  });

  it('recognises a held lock thrown by another copy of this package', async () => {
    // A port that resolves its own copy of @lde/search throws an error of a
    // different class with the same name.
    const foreign = Object.assign(new Error('held'), {
      name: 'RebuildAlreadyRunning',
    });

    await expect(
      requestRebuild(() => Promise.reject(foreign), memoryRequests()),
    ).resolves.toBeUndefined();
  });

  it('rejects with the rebuild’s error and does not run again', async () => {
    const requests = memoryRequests();
    let runs = 0;
    const rebuild = async () => {
      runs++;
      // A request recorded during the failed run is left for the next call.
      await requests.record();
      throw new Error('register unreachable');
    };

    await expect(requestRebuild(rebuild, requests)).rejects.toThrow(
      'register unreachable',
    );
    expect(runs).toBe(1);
  });
});

describe('RebuildAlreadyRunning', () => {
  it('names the index whose rebuild is running', () => {
    const error = new RebuildAlreadyRunning('datasets');

    expect(error.name).toBe('RebuildAlreadyRunning');
    expect(error.message).toBe(
      'Another rebuild of “datasets” is already running',
    );
  });
});
