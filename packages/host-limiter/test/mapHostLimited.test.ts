import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  createHostLimiter,
  hostKeyOf,
  mapHostLimited,
  positiveIntOrDefault,
  type HostLimiter,
} from '../src/index.js';

/**
 * A task that records how many of its kind are in flight, and hands back a
 * `release` per item so a test decides when each completes. Nothing sleeps:
 * concurrency is asserted from observed peaks, never from timing.
 */
function instrumentedTask(hostKeys: readonly string[]) {
  const releases: Array<() => void> = [];
  const started: number[] = [];
  let inFlight = 0;
  let peakTotal = 0;
  const peakPerHost = new Map<string, number>();
  const inFlightPerHost = new Map<string, number>();

  const task = (index: number): Promise<string> => {
    started.push(index);
    const host = hostKeys[index];
    inFlight++;
    peakTotal = Math.max(peakTotal, inFlight);
    const hostCount = (inFlightPerHost.get(host) ?? 0) + 1;
    inFlightPerHost.set(host, hostCount);
    peakPerHost.set(host, Math.max(peakPerHost.get(host) ?? 0, hostCount));
    return new Promise<string>((resolve) => {
      releases[index] = () => {
        inFlight--;
        inFlightPerHost.set(host, (inFlightPerHost.get(host) ?? 1) - 1);
        resolve(`result-${index}`);
      };
    });
  };

  const released = new Set<number>();
  const releaseStarted = (): void => {
    for (const index of started) {
      if (!released.has(index)) {
        released.add(index);
        releases[index]();
      }
    }
  };

  return {
    task,
    started,
    release: (index: number) => {
      released.add(index);
      releases[index]();
    },
    /** Release what has started, letting the scheduler queue more, until the
     *  whole batch has run – the caller then awaits the map itself. */
    drain: async (rounds: number) => {
      for (let round = 0; round < rounds; round++) {
        releaseStarted();
        await settle();
      }
    },
    get peakTotal() {
      return peakTotal;
    },
    peakFor: (host: string) => peakPerHost.get(host) ?? 0,
  };
}

/** Let every already-resolved promise settle, so the scheduler runs again. */
const settle = () => new Promise((resolve) => setImmediate(resolve));

describe('mapHostLimited', () => {
  it('holds the global cap across all hosts', async () => {
    const hostKeys = ['a', 'b', 'c', 'd', 'e'];
    const items = hostKeys.map((_unused, index) => index);
    const probe = instrumentedTask(hostKeys);

    const running = mapHostLimited(items, hostKeys, 2, 2, probe.task);
    await settle();

    expect(probe.peakTotal).toBe(2);
    await probe.drain(items.length);
    await running;
    // Draining the queue never lifts the cap either.
    expect(probe.peakTotal).toBe(2);
  });

  it('holds the per-host cap while the global pool has room', async () => {
    const hostKeys = ['a', 'a', 'a', 'a'];
    const items = hostKeys.map((_unused, index) => index);
    const probe = instrumentedTask(hostKeys);

    const running = mapHostLimited(items, hostKeys, 10, 2, probe.task);
    await probe.drain(items.length);
    await running;

    // The adaptive limit starts at 1 and rises to the cap, never past it.
    expect(probe.peakFor('a')).toBe(2);
  });

  it('lets a later item on a free host past a saturated one', async () => {
    // The queue leads with two items for the saturated host; without the skip,
    // `b` would wait behind them. Global room is ample, so only the per-host
    // cap can hold anything back.
    const hostKeys = ['a', 'a', 'a', 'b'];
    const items = hostKeys.map((_unused, index) => index);
    const probe = instrumentedTask(hostKeys);

    const running = mapHostLimited(items, hostKeys, 10, 1, probe.task);
    await settle();

    expect(probe.started).toEqual([0, 3]);
    await probe.drain(items.length);
    await running;
  });

  it('answers in input order however the tasks complete', async () => {
    const hostKeys = ['a', 'b', 'c'];
    const items = hostKeys.map((_unused, index) => index);
    const probe = instrumentedTask(hostKeys);

    const running = mapHostLimited(items, hostKeys, 3, 3, probe.task);
    await settle();
    // Settle back to front.
    probe.release(2);
    probe.release(1);
    probe.release(0);

    expect(await running).toEqual(['result-0', 'result-1', 'result-2']);
  });

  it('drains a queue longer than either cap', async () => {
    const hostKeys = Array.from({ length: 9 }, (_unused, index) =>
      index % 3 === 0 ? 'a' : 'b',
    );
    const items = hostKeys.map((_unused, index) => index);
    const settleImmediately = async (index: number) => `result-${index}`;

    expect(
      await mapHostLimited(items, hostKeys, 2, 1, settleImmediately),
    ).toEqual(items.map((index) => `result-${index}`));
  });

  it('answers an empty input without running anything', async () => {
    const probe = instrumentedTask([]);
    expect(await mapHostLimited([], [], 4, 2, probe.task)).toEqual([]);
    expect(probe.started).toEqual([]);
  });

  it('runs a single item', async () => {
    const probe = instrumentedTask(['a']);
    const running = mapHostLimited([0], ['a'], 4, 2, probe.task);
    await settle();
    probe.release(0);
    expect(await running).toEqual(['result-0']);
  });

  it('rejects, rather than crashing the process, when a task breaks its contract', async () => {
    // The contract says wrap failures into a result value. A caller who does not
    // should learn why – an unhandled rejection would take the process down
    // under Node's default, and hanging forever would say nothing at all.
    await expect(
      mapHostLimited(
        ['a', 'b'],
        ['example.org', 'example.org'],
        2,
        1,
        async (item) => {
          if (item === 'a') {
            throw new Error('task broke its contract');
          }
          return item;
        },
      ),
    ).rejects.toThrow('task broke its contract');
  });
});

describe('mapHostLimited after a rejection', () => {
  it('still runs the work that was queued', async () => {
    const started: string[] = [];
    const running = mapHostLimited(
      ['a', 'b'],
      ['example.org', 'example.org'],
      2,
      1,
      async (item) => {
        started.push(item);
        if (item === 'a') {
          throw new Error('task broke its contract');
        }
        return item;
      },
    );

    await expect(running).rejects.toThrow('task broke its contract');
    await settle();

    expect(started).toEqual(['a', 'b']);
  });
});

describe('createHostLimiter', () => {
  /** A task that stays in flight until the test calls its `release`. */
  function heldTask() {
    let release = (): void => undefined;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const task = vi.fn(() => held);
    return { task, release };
  }

  it('holds the per-host cap across separate callers', async () => {
    const limiter = createHostLimiter(10, 1);
    const first = heldTask();
    const second = heldTask();

    const running = [
      limiter.run('a', first.task),
      limiter.run('a', second.task),
    ];
    await settle();

    expect(first.task).toHaveBeenCalled();
    expect(second.task).not.toHaveBeenCalled();

    first.release();
    await settle();
    expect(second.task).toHaveBeenCalled();

    second.release();
    await Promise.all(running);
  });

  it('holds the global cap across separate callers', async () => {
    const limiter = createHostLimiter(1, 1);
    const first = heldTask();
    const second = heldTask();

    const running = [
      limiter.run('a', first.task),
      limiter.run('b', second.task),
    ];
    await settle();

    expect(second.task).not.toHaveBeenCalled();

    first.release();
    await settle();
    expect(second.task).toHaveBeenCalled();

    second.release();
    await Promise.all(running);
  });

  it('lets a later task on a free host past a saturated one', async () => {
    const limiter = createHostLimiter(10, 1);
    const holding = heldTask();
    const queued = heldTask();
    const elsewhere = heldTask();

    const running = [
      limiter.run('a', holding.task),
      limiter.run('a', queued.task),
      limiter.run('b', elsewhere.task),
    ];
    await settle();

    expect(queued.task).not.toHaveBeenCalled();
    expect(elsewhere.task).toHaveBeenCalled();

    holding.release();
    queued.release();
    elsewhere.release();
    await Promise.all(running);
  });

  it('answers with what the task answered', async () => {
    const limiter = createHostLimiter(1, 1);
    expect(await limiter.run('a', async () => 'an answer')).toBe('an answer');
  });

  it('frees the slot of a task that rejects', async () => {
    const limiter = createHostLimiter(1, 1);

    await expect(
      limiter.run('a', async () => {
        throw new Error('rejected');
      }),
    ).rejects.toThrow('rejected');

    expect(await limiter.run('a', async () => 'next')).toBe('next');
  });

  it('frees the slot of a task that throws synchronously', async () => {
    const limiter = createHostLimiter(1, 1);

    await expect(
      limiter.run('a', () => {
        throw new Error('thrown');
      }),
    ).rejects.toThrow('thrown');

    expect(await limiter.run('a', async () => 'next')).toBe('next');
  });
});

describe('hostKeyOf', () => {
  it('buckets on the host, so items sharing an origin contend', () => {
    expect(hostKeyOf(new URL('https://example.org/a'))).toBe('example.org');
    expect(hostKeyOf(new URL('https://example.org/b'))).toBe('example.org');
    // The port is part of the authority: two services on one machine are two
    // origins, and rate limits are per service.
    expect(hostKeyOf(new URL('https://example.org:8080/a'))).toBe(
      'example.org:8080',
    );
  });

  it('gives an authority-less URL a budget of its own', () => {
    // `''` for both would make two unrelated URNs contend for one budget.
    expect(hostKeyOf(new URL('urn:uuid:1234'))).toBe('urn:uuid:1234');
    expect(hostKeyOf(new URL('file:///data/dump.nt'))).toBe(
      'file:///data/dump.nt',
    );
  });
});

describe('positiveIntOrDefault', () => {
  it('takes a positive integer and falls back to the default otherwise', () => {
    expect(positiveIntOrDefault(3, 4)).toBe(3);
    expect(positiveIntOrDefault(1, 4)).toBe(1);
    for (const invalid of [undefined, 0, -1, 1.5, Number.NaN]) {
      expect(positiveIntOrDefault(invalid, 4), String(invalid)).toBe(4);
    }
  });
});

/**
 * Queue `count` tasks on `host`, each held until the test settles a round.
 * `round(outcome)` settles every task in flight – succeeding, or failing –
 * and reports how many that was, so a test reads the limit round by round.
 */
function queue(limiter: HostLimiter, host: string, count: number) {
  const inFlight: Array<{ succeed: () => void; fail: () => void }> = [];
  const settled = Promise.allSettled(
    Array.from({ length: count }, () =>
      limiter.run(
        host,
        () =>
          new Promise<void>((resolve, reject) => {
            inFlight.push({
              succeed: resolve,
              fail: () => reject(new Error('overloaded')),
            });
          }),
      ),
    ),
  );
  return {
    round: async (outcome: 'succeed' | 'fail' = 'succeed') => {
      await settle();
      const settling = inFlight.splice(0);
      for (const task of settling) {
        task[outcome]();
      }
      await settle();
      return settling.length;
    },
    /** Succeed whatever is in flight until nothing is left. */
    drain: async () => {
      while ((await settle(), inFlight.length > 0)) {
        for (const task of inFlight.splice(0)) {
          task.succeed();
        }
      }
      await settled;
    },
  };
}

describe('createHostLimiter’s adaptive per-host limit', () => {
  it('starts a host at one task and doubles per round of successes', async () => {
    const limiter = createHostLimiter(100, 100);
    expect(limiter.limitOf('a')).toBe(1);
    const tasks = queue(limiter, 'a', 20);

    const rounds = [
      await tasks.round(),
      await tasks.round(),
      await tasks.round(),
    ];

    expect(rounds).toEqual([1, 2, 4]);
    expect(limiter.limitOf('a')).toBe(8);
    await tasks.drain();
  });

  it('never rises above the per-host limit it was created with', async () => {
    const limiter = createHostLimiter(100, 3);
    const tasks = queue(limiter, 'a', 20);

    const rounds = [
      await tasks.round(),
      await tasks.round(),
      await tasks.round(),
    ];

    expect(rounds).toEqual([1, 2, 3]);
    expect(limiter.limitOf('a')).toBe(3);
    await tasks.drain();
  });

  it('halves once for a burst of failures, then grows by one per round', async () => {
    const limiter = createHostLimiter(100, 100);
    const tasks = queue(limiter, 'a', 60);
    await tasks.round();
    await tasks.round();
    await tasks.round(); // The limit is now 8.

    // All 8 fail together: one overload, not eight.
    expect(await tasks.round('fail')).toBe(8);
    expect(limiter.limitOf('a')).toBe(4);

    expect(await tasks.round()).toBe(4);
    expect(limiter.limitOf('a')).toBe(5);
    expect(await tasks.round()).toBe(5);
    expect(limiter.limitOf('a')).toBe(6);
    await tasks.drain();
  });

  it('halves again when tasks started after the last decrease fail too', async () => {
    const limiter = createHostLimiter(100, 100);
    const tasks = queue(limiter, 'a', 40);
    await tasks.round();
    await tasks.round();
    await tasks.round(); // 8

    await tasks.round('fail'); // 4
    await tasks.round('fail');

    expect(limiter.limitOf('a')).toBe(2);
    await tasks.drain();
  });

  it('does not raise the limit of a host whose tasks never wait', async () => {
    const limiter = createHostLimiter(100, 100);

    for (let task = 0; task < 10; task++) {
      await limiter.run('a', async () => undefined);
    }

    expect(limiter.limitOf('a')).toBe(1);
  });

  it('does not raise the limit of a host held back by the global cap', async () => {
    // Plenty is waiting, but the global cap keeps the host at one task in
    // flight: its limit grows once, for using its limit of 1, and then stops.
    const limiter = createHostLimiter(1, 100);
    const first = queue(limiter, 'a', 10);
    const second = queue(limiter, 'b', 10);

    for (let round = 0; round < 4; round++) {
      await first.round();
      await second.round();
    }

    expect(limiter.limitOf('a')).toBe(2);
    await first.drain();
    await second.drain();
  });

  it('forgets the least recently used idle hosts beyond a thousand', async () => {
    const limiter = createHostLimiter(100, 100);
    const remembered = queue(limiter, 'remembered', 3);
    await remembered.round();
    await remembered.drain(); // Its limit is now 2.
    const touchedLater = queue(limiter, 'touched later', 3);
    await touchedLater.round();
    await touchedLater.drain();

    for (let host = 0; host < 999; host++) {
      await limiter.run(`host ${host}`, async () => undefined);
    }

    expect(limiter.limitOf('remembered')).toBe(1);
    expect(limiter.limitOf('touched later')).toBe(2);
  });

  it('remembers a host with work in flight however many others pass', async () => {
    const limiter = createHostLimiter(100, 100);
    const busy = queue(limiter, 'busy', 4);
    await busy.round(); // Its limit is now 2, with 2 tasks in flight.

    for (let host = 0; host < 1_001; host++) {
      await limiter.run(`host ${host}`, async () => undefined);
    }

    expect(limiter.limitOf('busy')).toBe(2);
    await busy.drain();
  });
});

describe('HostLimiter.pause', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('starts no task for the host until the pause ends, then one at a time', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'Date'] });
    const limiter = createHostLimiter(100, 100);
    const started: number[] = [];
    const releases: Array<() => void> = [];
    const hold = (index: number) => () =>
      new Promise<void>((resolve) => {
        started.push(index);
        releases.push(resolve);
      });

    limiter.pause('a', Date.now() + 5_000);
    const running = [0, 1, 2].map((index) => limiter.run('a', hold(index)));
    const elsewhere = limiter.run('b', async () => 'not paused');
    await settle();

    expect(started).toEqual([]);
    expect(await elsewhere).toBe('not paused');

    await vi.advanceTimersByTimeAsync(5_000);
    await settle();
    expect(started).toEqual([0]);

    releases[0]();
    await settle();
    expect(started).toEqual([0, 1, 2]);
    releases[1]();
    releases[2]();
    await Promise.all(running);
  });

  it('drops the limit to one and slow-starts up to half the old limit', async () => {
    const limiter = createHostLimiter(100, 100);
    const tasks = queue(limiter, 'a', 80);
    await tasks.round();
    await tasks.round();
    await tasks.round();
    await tasks.round(); // 16

    limiter.pause('a', Date.now());

    expect(limiter.limitOf('a')).toBe(1);
    // In flight before the pause: failing now is the same overload, so the
    // limit is not halved again.
    expect(await tasks.round('fail')).toBe(16);
    expect(limiter.limitOf('a')).toBe(1);
    expect([
      await tasks.round(),
      await tasks.round(),
      await tasks.round(),
      await tasks.round(),
    ]).toEqual([1, 2, 4, 8]);
    expect(limiter.limitOf('a')).toBe(9);
    await tasks.drain();
  });

  it('ignores successes of tasks that started before the pause', async () => {
    const limiter = createHostLimiter(100, 100);
    const tasks = queue(limiter, 'a', 40);
    await tasks.round();
    await tasks.round();
    await tasks.round(); // 8

    limiter.pause('a', Date.now());
    expect(await tasks.round()).toBe(8);

    expect(limiter.limitOf('a')).toBe(1);
    await tasks.drain();
  });

  it('treats a pause while one is running as the same overload', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'Date'] });
    const limiter = createHostLimiter(100, 100);
    const tasks = queue(limiter, 'a', 80);
    await tasks.round();
    await tasks.round();
    await tasks.round();
    await tasks.round(); // 16

    limiter.pause('a', Date.now() + 1_000);
    limiter.pause('a', Date.now() + 2_000);
    await tasks.round(); // The 16 in flight settle and no longer count.
    await vi.advanceTimersByTimeAsync(2_000);

    // Slow start still runs up to 8, half the limit before the first pause.
    expect([
      await tasks.round(),
      await tasks.round(),
      await tasks.round(),
    ]).toEqual([1, 2, 4]);
    expect(limiter.limitOf('a')).toBe(8);
    await tasks.drain();
  });

  it('waits out a pause longer than a timer can hold', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'Date'] });
    const limiter = createHostLimiter(100, 100);
    const thirtyDays = 30 * 24 * 3_600_000;
    let started = false;

    limiter.pause('a', Date.now() + thirtyDays);
    const running = limiter.run('a', async () => {
      started = true;
    });
    await vi.advanceTimersByTimeAsync(thirtyDays - 1_000);

    expect(started).toBe(false);
    await vi.advanceTimersByTimeAsync(1_000);
    await running;
    expect(started).toBe(true);
  });

  it('never shortens a longer pause', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'Date'] });
    const limiter = createHostLimiter(100, 100);
    let started = false;

    limiter.pause('a', Date.now() + 10_000);
    limiter.pause('a', Date.now() + 1_000);
    const running = limiter.run('a', async () => {
      started = true;
    });
    await vi.advanceTimersByTimeAsync(5_000);

    expect(started).toBe(false);
    await vi.advanceTimersByTimeAsync(5_000);
    await running;
    expect(started).toBe(true);
  });
});
