import { describe, expect, it } from 'vitest';
import {
  hostKeyOf,
  mapHostLimited,
  positiveIntOrDefault,
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
    await settle();

    expect(probe.peakFor('a')).toBe(2);
    await probe.drain(items.length);
    await running;
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
