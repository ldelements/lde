import { describe, expect, it, vi } from 'vitest';
import {
  createResolver,
  memoryFactStore,
  urlHost,
  type FactStore,
  type ResolutionFailure,
  type StoredFact,
} from '../src/index.js';

/** A place, standing in for any fact resolved from outside the graph. */
interface Place {
  name: string;
}

const MAASTRICHT = 'https://sws.geonames.org/2751283/';
const VENLO = 'https://sws.geonames.org/2745706/';
const ELSEWHERE = 'https://vocab.example.org/place/1';

/** A resolver over IRI references, with everything a test does not care about
 *  defaulted: the key’s own host, no delay between retries, and an empty store. */
function resolverOver(
  fetch: (
    references: readonly string[],
    options: { signal: AbortSignal },
  ) => Promise<Array<[string, Place]>>,
  overrides: Partial<Parameters<typeof createResolver<string, Place>>[0]> = {},
) {
  const failures: ResolutionFailure[] = [];
  const resolver = createResolver<string, Place>({
    key: (iri) => iri,
    host: urlHost,
    fetch,
    report: (failure) => failures.push(failure),
    ...overrides,
    limits: { retryDelayMs: 0, ...overrides.limits },
  });
  return { resolver, failures };
}

/** A store holding these facts, stamped at this instant and version. */
function storeHolding(
  facts: Record<string, Place>,
  fetchedAt: string,
  version = '1',
): FactStore<Place> {
  const held = new Map<string, StoredFact<Place>>(
    Object.entries(facts).map(([key, fact]) => [
      key,
      { status: 'present', fact, fetchedAt, version },
    ]),
  );
  return memoryFactStore(held);
}

/** A store holding these keys as absences – the source answered and had none. */
function storeAbsences(
  keys: readonly string[],
  fetchedAt: string,
): FactStore<Place> {
  return memoryFactStore(
    new Map<string, StoredFact<Place>>(
      keys.map((key) => [key, { status: 'absent', fetchedAt, version: '1' }]),
    ),
  );
}

describe('resolveAll', () => {
  it('resolves a reference and says the fact is fresh', async () => {
    const { resolver } = resolverOver(async (iris) =>
      iris.map((iri) => [iri, { name: 'Maastricht' }]),
    );

    const resolved = await resolver.resolveAll([MAASTRICHT]);

    expect(resolved.get(MAASTRICHT)).toMatchObject({
      outcome: 'resolved',
      fact: { name: 'Maastricht' },
      fromStore: false,
    });
  });

  it('asks once for two references that share a key', async () => {
    const fetch = vi.fn(async (iris: readonly string[]) =>
      iris.map((iri): [string, Place] => [iri, { name: 'Maastricht' }]),
    );
    const { resolver } = resolverOver(fetch);

    const resolved = await resolver.resolveAll([MAASTRICHT, MAASTRICHT]);

    expect(fetch).toHaveBeenCalledTimes(1);
    expect(fetch.mock.calls[0][0]).toEqual([MAASTRICHT]);
    expect(resolved.size).toBe(1);
  });

  it('serves a stored fact without asking the source at all', async () => {
    const fetch = vi.fn(async () => []);
    const { resolver, failures } = resolverOver(fetch, {
      store: storeHolding(
        { [MAASTRICHT]: { name: 'Maastricht' } },
        '2026-01-01T00:00:00.000Z',
      ),
    });

    const resolved = await resolver.resolveAll([MAASTRICHT]);

    expect(fetch).not.toHaveBeenCalled();
    expect(resolved.get(MAASTRICHT)).toEqual({
      outcome: 'resolved',
      fact: { name: 'Maastricht' },
      fetchedAt: '2026-01-01T00:00:00.000Z',
      fromStore: true,
    });
    // A store doing its job is not a failure.
    expect(failures).toEqual([]);
  });

  it('persists what it fetched, so the next run costs no request', async () => {
    const store = memoryFactStore<Place>();
    const fetch = vi.fn(async (iris: readonly string[]) =>
      iris.map((iri): [string, Place] => [iri, { name: 'Maastricht' }]),
    );
    const { resolver } = resolverOver(fetch, { store });

    await resolver.resolveAll([MAASTRICHT]);
    const second = await resolver.resolveAll([MAASTRICHT]);

    expect(fetch).toHaveBeenCalledTimes(1);
    expect(second.get(MAASTRICHT)).toMatchObject({ fromStore: true });
  });

  it('degrades one reference rather than the batch when a fetch throws', async () => {
    // Isolation is the point: batchSize 1 makes each reference its own call, so
    // the failing one cannot take the healthy one down with it.
    const { resolver, failures } = resolverOver(
      async (iris) => {
        if (iris.includes(VENLO)) {
          throw new Error('upstream exploded');
        }
        return iris.map((iri) => [iri, { name: 'Maastricht' }]);
      },
      { limits: { retries: 0 } },
    );

    const resolved = await resolver.resolveAll([MAASTRICHT, VENLO]);

    expect(resolved.get(MAASTRICHT)).toMatchObject({ outcome: 'resolved' });
    expect(resolved.get(VENLO)).toMatchObject({
      outcome: 'unresolved',
      reason: 'resolution failed after 1 attempt(s): upstream exploded',
    });
    expect(failures).toHaveLength(1);
    expect(failures[0]).toMatchObject({ key: VENLO, degradedToStore: false });
  });

  it('degrades a failed fetch to the stored fact, never to absent', async () => {
    const { resolver, failures } = resolverOver(
      async () => {
        throw new Error('upstream exploded');
      },
      {
        // Stale, so a refresh is attempted; the store still answers when it fails.
        store: storeHolding(
          { [MAASTRICHT]: { name: 'Maastricht' } },
          '2020-01-01T00:00:00.000Z',
        ),
        limits: { retries: 0, ttlMs: 1 },
      },
    );

    const resolved = await resolver.resolveAll([MAASTRICHT]);

    expect(resolved.get(MAASTRICHT)).toMatchObject({
      outcome: 'resolved',
      fact: { name: 'Maastricht' },
      fetchedAt: '2020-01-01T00:00:00.000Z',
      fromStore: true,
    });
    expect(failures[0]).toMatchObject({
      key: MAASTRICHT,
      degradedToStore: true,
    });
  });

  it('describes a thrown non-Error in the reason', async () => {
    const { resolver } = resolverOver(
      async () => {
        // A GraphQL client rejecting with a plain value, not an Error.
        throw 'source timed out';
      },
      { limits: { retries: 0 } },
    );

    expect(await resolver.resolveAll([MAASTRICHT])).toEqual(
      new Map([
        [
          MAASTRICHT,
          {
            outcome: 'unresolved',
            reason: 'resolution failed after 1 attempt(s): source timed out',
          },
        ],
      ]),
    );
  });

  it('retries a failing fetch and keeps what the retry found', async () => {
    let attempts = 0;
    const { resolver } = resolverOver(async (iris) => {
      attempts++;
      if (attempts < 3) {
        throw new Error('transient');
      }
      return iris.map((iri) => [iri, { name: 'Maastricht' }]);
    });

    const resolved = await resolver.resolveAll([MAASTRICHT]);

    expect(attempts).toBe(3); // the attempt plus the two default retries
    expect(resolved.get(MAASTRICHT)).toMatchObject({ outcome: 'resolved' });
  });

  it('gives up after the configured retries, naming the attempts', async () => {
    let attempts = 0;
    const { resolver } = resolverOver(
      async () => {
        attempts++;
        throw new Error('still down');
      },
      { limits: { retries: 1 } },
    );

    const resolved = await resolver.resolveAll([MAASTRICHT]);

    expect(attempts).toBe(2);
    expect(resolved.get(MAASTRICHT)).toEqual({
      outcome: 'unresolved',
      reason: 'resolution failed after 2 attempt(s): still down',
    });
  });
});

describe('an absence', () => {
  it('is an answer of its own, not a failure and not a fact', async () => {
    const { resolver, failures } = resolverOver(async () => []);

    const resolved = await resolver.resolveAll([ELSEWHERE]);

    expect(resolved.get(ELSEWHERE)).toMatchObject({ outcome: 'absent' });
    // The source answered. Nothing went wrong, so nothing is reported.
    expect(failures).toEqual([]);
  });

  it('is remembered, so the source is not asked the same question every run', async () => {
    const store = memoryFactStore<Place>();
    const fetch = vi.fn(async () => []);
    const { resolver } = resolverOver(fetch, { store });

    await resolver.resolveAll([ELSEWHERE]);
    const second = await resolver.resolveAll([ELSEWHERE]);

    expect(fetch).toHaveBeenCalledTimes(1);
    expect(second.get(ELSEWHERE)).toMatchObject({ outcome: 'absent' });
  });

  it('does not crowd out a key that has never been asked', async () => {
    // The budget is the scarce thing: an absence re-asked every run would spend
    // it on a question already answered, and a cold store would never warm.
    const asked: string[][] = [];
    const { resolver } = resolverOver(
      async (iris) => {
        asked.push([...iris]);
        return iris.map((iri) => [iri, { name: 'fresh' }]);
      },
      {
        store: storeAbsences([ELSEWHERE], '2026-08-24T00:00:00.000Z'),
        now: () => new Date('2026-08-24T00:00:01.000Z'),
        limits: { fetchesPerResolver: 1 },
      },
    );

    await resolver.resolveAll([ELSEWHERE, MAASTRICHT]);

    expect(asked).toEqual([[MAASTRICHT]]);
  });

  it('is believed for a week and then asked again', async () => {
    const fetch = vi.fn(async (iris: readonly string[]) =>
      iris.map((iri): [string, Place] => [iri, { name: 'appeared' }]),
    );
    const { resolver } = resolverOver(fetch, {
      store: storeAbsences([ELSEWHERE], '2026-08-01T00:00:00.000Z'),
      // Eight days later: an absence is a weaker claim than a fact, so it
      // expires by default where a fact would not.
      now: () => new Date('2026-08-09T00:00:00.000Z'),
    });

    const resolved = await resolver.resolveAll([ELSEWHERE]);

    expect(fetch).toHaveBeenCalledTimes(1);
    expect(resolved.get(ELSEWHERE)).toMatchObject({ outcome: 'resolved' });
  });

  it('stands in when a later refresh fails, rather than becoming unknown', async () => {
    const { resolver, failures } = resolverOver(
      async () => {
        throw new Error('upstream exploded');
      },
      {
        store: storeAbsences([ELSEWHERE], '2026-08-01T00:00:00.000Z'),
        now: () => new Date('2026-08-09T00:00:00.000Z'),
        limits: { retries: 0 },
      },
    );

    const resolved = await resolver.resolveAll([ELSEWHERE]);

    expect(resolved.get(ELSEWHERE)).toEqual({
      outcome: 'absent',
      fetchedAt: '2026-08-01T00:00:00.000Z',
    });
    expect(failures[0]).toMatchObject({
      key: ELSEWHERE,
      degradedToStore: true,
    });
  });
});

describe('the resolver’s fetch budget', () => {
  it('spends it on the keys with nothing stored before the merely stale ones', async () => {
    const asked: string[][] = [];
    const { resolver } = resolverOver(
      async (iris) => {
        asked.push([...iris]);
        return iris.map((iri) => [iri, { name: 'fresh' }]);
      },
      {
        // VENLO is stale; MAASTRICHT is not stored at all. One fetch to spend.
        store: storeHolding(
          { [VENLO]: { name: 'stored' } },
          '2020-01-01T00:00:00.000Z',
        ),
        limits: { fetchesPerResolver: 1, ttlMs: 1 },
      },
    );

    const resolved = await resolver.resolveAll([VENLO, MAASTRICHT]);

    expect(asked).toEqual([[MAASTRICHT]]);
    expect(resolved.get(MAASTRICHT)).toMatchObject({ fromStore: false });
    // The stale one still answers – from the store, ageing rather than absent.
    expect(resolved.get(VENLO)).toMatchObject({
      fromStore: true,
      fact: { name: 'stored' },
    });
  });

  it('warms a cold store over successive runs rather than in one burst', async () => {
    const store = memoryFactStore<Place>();
    const asked: string[][] = [];
    const { resolver } = resolverOver(
      async (iris) => {
        asked.push([...iris]);
        return iris.map((iri) => [iri, { name: 'fetched' }]);
      },
      { store, limits: { fetchesPerResolver: 1 } },
    );

    // The budget spans the resolver, not one call: a second resolveAll does not
    // hand the source a fresh allowance.
    await resolver.resolveAll([MAASTRICHT]);
    const second = await resolver.resolveAll([VENLO]);

    expect(asked).toEqual([[MAASTRICHT]]);
    expect(second.get(VENLO)).toMatchObject({ outcome: 'unresolved' });
    expect(second.get(VENLO)).toMatchObject({
      reason: expect.stringContaining('fetchesPerResolver'),
    });
  });

  it('does not report a key the budget merely deferred', async () => {
    // The cap working as designed is not a failure, and on a cold store this
    // would be a callback per deferred key.
    const { resolver, failures } = resolverOver(
      async (iris) => iris.map((iri) => [iri, { name: 'fetched' }]),
      { limits: { fetchesPerResolver: 1 } },
    );

    await resolver.resolveAll([MAASTRICHT, VENLO]);

    expect(failures).toEqual([]);
  });
});

describe('the TTL', () => {
  it('marks a stored fact stale so it is refetched', async () => {
    const fetch = vi.fn(async (iris: readonly string[]) =>
      iris.map((iri): [string, Place] => [iri, { name: 'refreshed' }]),
    );
    const { resolver } = resolverOver(fetch, {
      store: storeHolding(
        { [MAASTRICHT]: { name: 'stale' } },
        '2020-01-01T00:00:00.000Z',
      ),
      limits: { ttlMs: 1 },
    });

    const resolved = await resolver.resolveAll([MAASTRICHT]);

    expect(fetch).toHaveBeenCalledTimes(1);
    expect(resolved.get(MAASTRICHT)).toMatchObject({
      fact: { name: 'refreshed' },
      fromStore: false,
    });
  });

  it('leaves a fact inside the TTL alone', async () => {
    const fetch = vi.fn(async () => []);
    const { resolver } = resolverOver(fetch, {
      store: storeHolding(
        { [MAASTRICHT]: { name: 'recent' } },
        '2026-08-24T00:00:00.000Z',
      ),
      now: () => new Date('2026-08-24T00:00:01.000Z'),
      limits: { ttlMs: 60_000 },
    });

    await resolver.resolveAll([MAASTRICHT]);

    expect(fetch).not.toHaveBeenCalled();
  });

  it('treats an unreadable stamp as stale rather than trusting it', async () => {
    const fetch = vi.fn(async (iris: readonly string[]) =>
      iris.map((iri): [string, Place] => [iri, { name: 'refreshed' }]),
    );
    const { resolver } = resolverOver(fetch, {
      store: storeHolding({ [MAASTRICHT]: { name: 'whenever' } }, 'not a date'),
      limits: { ttlMs: 60_000 },
    });

    await resolver.resolveAll([MAASTRICHT]);

    expect(fetch).toHaveBeenCalledTimes(1);
  });
});

describe('the fact version', () => {
  it('refetches a row derived by another version, however fresh it is', async () => {
    const fetch = vi.fn(async (iris: readonly string[]) =>
      iris.map((iri): [string, Place] => [iri, { name: 'rederived' }]),
    );
    const { resolver } = resolverOver(fetch, {
      // Stored a second ago, but by a derivation that shaped facts differently.
      store: storeHolding(
        { [MAASTRICHT]: { name: 'old shape' } },
        '2026-08-24T00:00:00.000Z',
        '1',
      ),
      now: () => new Date('2026-08-24T00:00:01.000Z'),
      version: '2',
    });

    const resolved = await resolver.resolveAll([MAASTRICHT]);

    expect(fetch).toHaveBeenCalledTimes(1);
    expect(resolved.get(MAASTRICHT)).toMatchObject({
      fact: { name: 'rederived' },
      fromStore: false,
    });
  });

  it('never serves a row of the wrong shape, even when the refetch fails', async () => {
    const { resolver } = resolverOver(
      async () => {
        throw new Error('upstream exploded');
      },
      {
        store: storeHolding(
          { [MAASTRICHT]: { name: 'old shape' } },
          '2026-08-24T00:00:00.000Z',
          '1',
        ),
        version: '2',
        limits: { retries: 0 },
      },
    );

    const resolved = await resolver.resolveAll([MAASTRICHT]);

    expect(resolved.get(MAASTRICHT)).toMatchObject({ outcome: 'unresolved' });
  });
});

describe('an attempt that outruns its deadline', () => {
  it('fails rather than hanging the run', async () => {
    const { resolver, failures } = resolverOver(
      // Never settles on its own: without a deadline, resolveAll never returns.
      () => new Promise(() => undefined),
      { limits: { retries: 0, timeoutMs: 5 } },
    );

    const resolved = await resolver.resolveAll([MAASTRICHT]);

    expect(resolved.get(MAASTRICHT)).toMatchObject({
      outcome: 'unresolved',
      reason: 'resolution failed after 1 attempt(s): timed out after 5ms',
    });
    expect(failures).toHaveLength(1);
  });

  it('aborts the signal it handed the caller, so the request can be cancelled', async () => {
    let aborted = false;
    const { resolver } = resolverOver(
      (_references, { signal }) =>
        new Promise(() => {
          signal.addEventListener('abort', () => {
            aborted = true;
          });
        }),
      { limits: { retries: 0, timeoutMs: 5 } },
    );

    await resolver.resolveAll([MAASTRICHT]);

    expect(aborted).toBe(true);
  });
});

describe('a host that is down', () => {
  it('is written off rather than asked once per reference', async () => {
    const asked: string[][] = [];
    const { resolver } = resolverOver(
      async (iris) => {
        asked.push([...iris]);
        throw new Error('connection refused');
      },
      {
        limits: {
          retries: 0,
          batchSize: 1,
          perHostConcurrency: 1,
          hostFailureThreshold: 2,
        },
      },
    );

    const resolved = await resolver.resolveAll([
      MAASTRICHT,
      VENLO,
      'https://sws.geonames.org/1/',
      'https://sws.geonames.org/2/',
    ]);

    // Two batches fail, the breaker trips, and the rest are never contacted.
    expect(asked).toHaveLength(2);
    expect(resolved.get('https://sws.geonames.org/2/')).toMatchObject({
      outcome: 'unresolved',
      reason: expect.stringContaining('written off'),
    });
  });

  it('takes no other host down with it', async () => {
    const { resolver } = resolverOver(
      async (iris) => {
        if (iris.some((iri) => iri.includes('geonames'))) {
          throw new Error('connection refused');
        }
        return iris.map((iri) => [iri, { name: 'elsewhere' }]);
      },
      {
        limits: {
          retries: 0,
          batchSize: 1,
          perHostConcurrency: 1,
          hostFailureThreshold: 2,
        },
      },
    );

    const resolved = await resolver.resolveAll([MAASTRICHT, VENLO, ELSEWHERE]);

    expect(resolved.get(ELSEWHERE)).toMatchObject({ outcome: 'resolved' });
  });

  it('spends no budget on the references it never contacted', async () => {
    // Written-off references send nothing, so charging them would let one dead
    // host consume a whole run’s allowance without a packet leaving the process.
    const asked: string[][] = [];
    const { resolver } = resolverOver(
      async (iris) => {
        asked.push([...iris]);
        if (iris.some((iri) => iri.includes('geonames'))) {
          throw new Error('connection refused');
        }
        return iris.map((iri) => [iri, { name: 'elsewhere' }]);
      },
      {
        limits: {
          retries: 0,
          batchSize: 1,
          fetchesPerResolver: 3,
          hostFailureThreshold: 2,
        },
      },
    );

    await resolver.resolveAll([
      MAASTRICHT,
      VENLO,
      'https://sws.geonames.org/1/',
    ]);
    const second = await resolver.resolveAll([ELSEWHERE]);

    // The third geonames reference was written off and refunded, so the healthy
    // host is still affordable afterwards.
    expect(second.get(ELSEWHERE)).toMatchObject({ outcome: 'resolved' });
    expect(asked).toContainEqual([ELSEWHERE]);
  });

  it('does not deny a live host the budget a dead one never spent', async () => {
    // The refund has to land inside this call: charging up front and refunding
    // afterwards would let a dead host answer a live one with a budget that was
    // handed straight back – and a deferral is not reported, so nothing would
    // say so.
    const asked: string[][] = [];
    const { resolver } = resolverOver(
      async (iris) => {
        asked.push([...iris]);
        if (iris.some((iri) => iri.includes('geonames'))) {
          throw new Error('connection refused');
        }
        return iris.map((iri) => [iri, { name: 'elsewhere' }]);
      },
      {
        limits: {
          retries: 0,
          batchSize: 1,
          hostFailureThreshold: 2,
          fetchesPerResolver: 4,
        },
      },
    );

    const resolved = await resolver.resolveAll([
      MAASTRICHT,
      VENLO,
      'https://sws.geonames.org/1/',
      'https://sws.geonames.org/2/',
      ELSEWHERE,
    ]);

    // Two dead references are contacted, the breaker trips, the other two are
    // written off and refunded – which pays for the live host in this same call.
    expect(resolved.get(ELSEWHERE)).toMatchObject({ outcome: 'resolved' });
    expect(asked).toContainEqual([ELSEWHERE]);
  });

  it('stops re-spending when nothing was refunded', async () => {
    // Every reference was contacted, so there is no refund to re-spend and the
    // rest stay deferred rather than looping.
    const asked: string[][] = [];
    const { resolver } = resolverOver(
      async (iris) => {
        asked.push([...iris]);
        return iris.map((iri) => [iri, { name: 'a place' }]);
      },
      { limits: { batchSize: 1, fetchesPerResolver: 1 } },
    );

    const resolved = await resolver.resolveAll([MAASTRICHT, ELSEWHERE]);

    expect(asked).toEqual([[MAASTRICHT]]);
    expect(resolved.get(ELSEWHERE)).toMatchObject({ outcome: 'unresolved' });
  });

  it('takes a caller’s own threshold for writing a host off', async () => {
    const asked: string[][] = [];
    const { resolver } = resolverOver(
      async (iris) => {
        asked.push([...iris]);
        throw new Error('connection refused');
      },
      {
        // perHostConcurrency 1, so nothing else is already in flight when the
        // first failure settles.
        limits: {
          retries: 0,
          batchSize: 1,
          perHostConcurrency: 1,
          hostFailureThreshold: 1,
        },
      },
    );

    await resolver.resolveAll([
      MAASTRICHT,
      VENLO,
      'https://sws.geonames.org/1/',
    ]);

    // One failure is enough for this source, so only the first is contacted.
    expect(asked).toEqual([[MAASTRICHT]]);
  });

  it('is asked again on the next run, so a recovery is not hidden', async () => {
    // The breaker lives on the resolver, and a resolver is one run.
    let down = true;
    const fetchFrom = () => async (iris: readonly string[]) => {
      if (down) {
        throw new Error('connection refused');
      }
      return iris.map((iri): [string, Place] => [iri, { name: 'back up' }]);
    };
    const store = memoryFactStore<Place>();
    const first = resolverOver(fetchFrom(), {
      store,
      limits: { retries: 0, batchSize: 1, hostFailureThreshold: 2 },
    });
    await first.resolver.resolveAll([MAASTRICHT, VENLO]);

    down = false;
    const second = resolverOver(fetchFrom(), {
      store,
      limits: { retries: 0, batchSize: 1, hostFailureThreshold: 2 },
    });
    const resolved = await second.resolver.resolveAll([MAASTRICHT]);

    expect(resolved.get(MAASTRICHT)).toMatchObject({ outcome: 'resolved' });
  });
});

describe('batching and bounding', () => {
  it('asks for a whole batch in one call when the source takes a list', async () => {
    const asked: string[][] = [];
    const { resolver } = resolverOver(
      async (iris) => {
        asked.push([...iris]);
        return iris.map((iri) => [iri, { name: 'a place' }]);
      },
      { limits: { batchSize: 10 } },
    );

    await resolver.resolveAll([MAASTRICHT, VENLO]);

    expect(asked).toEqual([[MAASTRICHT, VENLO]]);
  });

  it('never mixes hosts in one batch, so the per-host cap means something', async () => {
    const asked: string[][] = [];
    const { resolver } = resolverOver(
      async (iris) => {
        asked.push([...iris]);
        return iris.map((iri) => [iri, { name: 'a place' }]);
      },
      { limits: { batchSize: 10 } },
    );

    await resolver.resolveAll([MAASTRICHT, ELSEWHERE, VENLO]);

    expect(asked).toHaveLength(2);
    expect(asked).toContainEqual([MAASTRICHT, VENLO]);
    expect(asked).toContainEqual([ELSEWHERE]);
  });

  it('holds the per-host cap across batches', async () => {
    let inFlight = 0;
    let peak = 0;
    const { resolver } = resolverOver(
      async (iris) => {
        inFlight++;
        peak = Math.max(peak, inFlight);
        await new Promise((resolve) => setImmediate(resolve));
        inFlight--;
        return iris.map((iri) => [iri, { name: 'a place' }]);
      },
      { limits: { batchSize: 1, perHostConcurrency: 1, concurrency: 10 } },
    );

    await resolver.resolveAll([MAASTRICHT, VENLO]);

    expect(peak).toBe(1);
  });

  it('gives an opaque key a contention budget of its own', async () => {
    // Not a URL, so there is no host to share; bucketing every such key under
    // one name would serialize unrelated work.
    let inFlight = 0;
    let peak = 0;
    const { resolver } = resolverOver(
      async (keys) => {
        inFlight++;
        peak = Math.max(peak, inFlight);
        await new Promise((resolve) => setImmediate(resolve));
        inFlight--;
        return keys.map((key) => [key, { name: key }]);
      },
      { limits: { batchSize: 1, perHostConcurrency: 1, concurrency: 10 } },
    );

    // 'term:one' parses as a URL and buckets on its href; 'not a key at all'
    // does not parse, and falls back to itself. Neither shares a budget.
    await resolver.resolveAll(['term:one', 'not a key at all']);

    expect(peak).toBe(2);
  });

  it('takes a constant host for a source that fetches through one endpoint', async () => {
    let inFlight = 0;
    let peak = 0;
    const { resolver } = resolverOver(
      async (iris) => {
        inFlight++;
        peak = Math.max(peak, inFlight);
        await new Promise((resolve) => setImmediate(resolve));
        inFlight--;
        return iris.map((iri) => [iri, { name: 'a place' }]);
      },
      {
        // Two hosts by their keys; one endpoint in fact, because the lookup goes
        // through an aggregator. The bound belongs to the host contacted.
        host: 'gateway.example.org',
        limits: { batchSize: 10, perHostConcurrency: 1, concurrency: 10 },
      },
    );

    const asked = await resolver.resolveAll([MAASTRICHT, ELSEWHERE]);

    expect(peak).toBe(1);
    // One host means one batch, so a batching source sends one request.
    expect(asked.size).toBe(2);
  });

  it('resolves nothing, and asks nothing, for an empty input', async () => {
    const fetch = vi.fn(async () => []);
    const { resolver } = resolverOver(fetch);

    expect((await resolver.resolveAll([])).size).toBe(0);
    expect(fetch).not.toHaveBeenCalled();
  });
});

describe('the store seam', () => {
  it('purges a key, so the next run resolves it afresh', async () => {
    const store = memoryFactStore<Place>();
    const fetch = vi.fn(async (iris: readonly string[]) =>
      iris.map((iri): [string, Place] => [iri, { name: 'Maastricht' }]),
    );
    const { resolver } = resolverOver(fetch, { store });

    await resolver.resolveAll([MAASTRICHT]);
    await resolver.purge([MAASTRICHT]);
    await resolver.resolveAll([MAASTRICHT]);

    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it('fails a run at check() when the store cannot persist', async () => {
    const store: FactStore<Place> = {
      ...memoryFactStore<Place>(),
      check: async () => {
        throw new Error('volume is read-only');
      },
    };
    const { resolver } = resolverOver(async () => [], { store });

    await expect(resolver.check()).rejects.toThrow('volume is read-only');
  });

  it('passes check() when the store does not offer one', async () => {
    const { resolver } = resolverOver(async () => []);
    await expect(resolver.check()).resolves.toBeUndefined();
  });
});

describe('memoryFactStore', () => {
  it('holds, answers and forgets', async () => {
    const store = memoryFactStore<Place>();

    await store.set(
      new Map([
        [MAASTRICHT, { status: 'present', fact: { name: 'Maastricht' } }],
      ]),
      '2026-08-24T00:00:00.000Z',
      '1',
    );
    expect(await store.get([MAASTRICHT, VENLO])).toEqual(
      new Map([
        [
          MAASTRICHT,
          {
            status: 'present',
            fact: { name: 'Maastricht' },
            fetchedAt: '2026-08-24T00:00:00.000Z',
            version: '1',
          },
        ],
      ]),
    );

    await store.purge([MAASTRICHT]);
    expect(await store.get([MAASTRICHT])).toEqual(new Map());
  });

  it('holds an absence as an answer, with no fact at all', async () => {
    const store = memoryFactStore<Place>();

    await store.set(
      new Map([[ELSEWHERE, { status: 'absent' }]]),
      '2026-08-24T00:00:00.000Z',
      '1',
    );

    expect(await store.get([ELSEWHERE])).toEqual(
      new Map([
        [
          ELSEWHERE,
          {
            status: 'absent',
            fetchedAt: '2026-08-24T00:00:00.000Z',
            version: '1',
          },
        ],
      ]),
    );
  });
});
