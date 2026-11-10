import { createHostLimiter } from '@lde/host-limiter';
import { describe, expect, it, vi } from 'vitest';
import {
  createResolver,
  memoryFactStore,
  parseRetryAfter,
  referenceFailure,
  RetryableError,
  urlHost,
  type FactStore,
  type ReferenceFailure,
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
 *  defaulted: the key’s own host and an empty store. */
function resolverOver(
  fetch: (
    references: readonly string[],
    options: { signal: AbortSignal },
  ) => Promise<Array<[string, Place | ReferenceFailure]>>,
  overrides: Partial<Parameters<typeof createResolver<string, Place>>[0]> = {},
) {
  const failures: ResolutionFailure[] = [];
  const resolver = createResolver<string, Place>({
    key: (iri) => iri,
    host: urlHost,
    fetch,
    report: (failure) => failures.push(failure),
    ...overrides,
    limits: overrides.limits,
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
    const { resolver, failures } = resolverOver(async (iris) => {
      if (iris.includes(VENLO)) {
        throw new Error('upstream exploded');
      }
      return iris.map((iri) => [iri, { name: 'Maastricht' }]);
    });

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
        limits: { ttlMs: 1 },
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
    const { resolver } = resolverOver(async () => {
      // A GraphQL client rejecting with a plain value, not an Error.
      throw 'source timed out';
    });

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
});

describe('a failure', () => {
  it('is not retried within the run when a retry would not fix it', async () => {
    // A 500 or a 502 a moment later is the same 500 or 502; the next run tries again.
    let attempts = 0;
    const { resolver } = resolverOver(async () => {
      attempts++;
      throw new Error('HTTP 500');
    });

    const resolved = await resolver.resolveAll([MAASTRICHT]);

    expect(attempts).toBe(1);
    expect(resolved.get(MAASTRICHT)).toEqual({
      outcome: 'unresolved',
      reason: 'resolution failed after 1 attempt(s): HTTP 500',
    });
  });

  it('is tried once more at the back of the queue when the connection broke', async () => {
    // What Node’s fetch throws when a socket is reset mid-request.
    let attempts = 0;
    const { resolver } = resolverOver(async (iris) => {
      attempts++;
      if (attempts === 1) {
        throw new TypeError('fetch failed', {
          cause: Object.assign(new Error('read ECONNRESET'), {
            code: 'ECONNRESET',
          }),
        });
      }
      return iris.map((iri) => [iri, { name: 'Maastricht' }]);
    });

    const resolved = await resolver.resolveAll([MAASTRICHT]);

    expect(attempts).toBe(2);
    expect(resolved.get(MAASTRICHT)).toMatchObject({ outcome: 'resolved' });
  });

  it('is not tried again for a host name that does not exist', async () => {
    let attempts = 0;
    const { resolver } = resolverOver(async () => {
      attempts++;
      throw new TypeError('fetch failed', {
        cause: Object.assign(new Error('getaddrinfo ENOTFOUND'), {
          code: 'ENOTFOUND',
        }),
      });
    });

    await resolver.resolveAll([MAASTRICHT]);

    expect(attempts).toBe(1);
  });

  it('is retried when the source says to come back later, and keeps what the retry found', async () => {
    let attempts = 0;
    const { resolver } = resolverOver(async (iris) => {
      attempts++;
      if (attempts < 3) {
        throw new RetryableError('HTTP 429', { retryAfterMs: 1 });
      }
      return iris.map((iri) => [iri, { name: 'Maastricht' }]);
    });

    const resolved = await resolver.resolveAll([MAASTRICHT]);

    expect(attempts).toBe(3);
    expect(resolved.get(MAASTRICHT)).toMatchObject({ outcome: 'resolved' });
  });

  it('gives up on coming back later after two retries, naming the attempts', async () => {
    let attempts = 0;
    const { resolver } = resolverOver(async () => {
      attempts++;
      throw new RetryableError('HTTP 429', { retryAfterMs: 1 });
    });

    const resolved = await resolver.resolveAll([MAASTRICHT]);

    expect(attempts).toBe(3);
    expect(resolved.get(MAASTRICHT)).toEqual({
      outcome: 'unresolved',
      reason: 'resolution failed after 3 attempt(s): HTTP 429',
    });
  });

  it('is not waited out when the source asks for longer than an attempt may take', async () => {
    let attempts = 0;
    const { resolver } = resolverOver(
      async () => {
        attempts++;
        throw new RetryableError('HTTP 503', { retryAfterMs: 3_600_000 });
      },
      { limits: { timeoutMs: 50 } },
    );

    const resolved = await resolver.resolveAll([MAASTRICHT]);

    expect(attempts).toBe(1);
    expect(resolved.get(MAASTRICHT)).toEqual({
      outcome: 'unresolved',
      reason:
        'resolution failed after 1 attempt(s): HTTP 503; asked to retry after 3600000ms, longer than the 50ms timeout',
    });
  });

  it('is retried twice and no more, even when it wraps a broken connection', async () => {
    let attempts = 0;
    const { resolver } = resolverOver(async () => {
      attempts++;
      throw new RetryableError('HTTP 503', {
        retryAfterMs: 1,
        cause: Object.assign(new Error('read ECONNRESET'), {
          code: 'ECONNRESET',
        }),
      });
    });

    await resolver.resolveAll([MAASTRICHT]);

    expect(attempts).toBe(3);
  });

  it('waits out a pause without holding a slot another host could use', async () => {
    const startedAt = new Map<string, number>();
    let rateLimited = false;
    const began = Date.now();
    const { resolver } = resolverOver(
      async (iris) => {
        const [iri] = iris;
        if (!startedAt.has(iri)) {
          startedAt.set(iri, Date.now() - began);
        }
        if (iri === MAASTRICHT && !rateLimited) {
          rateLimited = true;
          throw new RetryableError('HTTP 429', { retryAfterMs: 200 });
        }
        return iris.map((each) => [each, { name: 'a place' }]);
      },
      { limiter: createHostLimiter(1, 2) },
    );

    const resolved = await resolver.resolveAll([MAASTRICHT, ELSEWHERE]);

    expect(resolved.get(MAASTRICHT)).toMatchObject({ outcome: 'resolved' });
    expect(startedAt.get(ELSEWHERE)).toBeLessThan(150);
  });

  it('backs off on its own when the source asks for no wait at all', async () => {
    // `Retry-After: 0`, or a date skewed into the past, names no real delay.
    const attemptedAt: number[] = [];
    const { resolver } = resolverOver(async (iris) => {
      attemptedAt.push(Date.now());
      if (attemptedAt.length === 1) {
        throw new RetryableError('HTTP 429', { retryAfterMs: 0 });
      }
      return iris.map((iri) => [iri, { name: 'Maastricht' }]);
    });

    await resolver.resolveAll([MAASTRICHT]);

    expect(attemptedAt[1] - attemptedAt[0]).toBeGreaterThanOrEqual(495);
  });

  it('keeps its charge and its reason when the host is written off during its pause', async () => {
    // Maastricht was sent and told to come back later; Venlo’s 502 writes the
    // host off meanwhile. Maastricht must not read as never contacted.
    const asked: string[] = [];
    const { resolver } = resolverOver(
      async (iris) => {
        asked.push(...iris);
        if (iris.includes(MAASTRICHT)) {
          throw new RetryableError('HTTP 429', { retryAfterMs: 30 });
        }
        if (iris.includes(VENLO)) {
          throw new Error('HTTP 502');
        }
        return iris.map((iri) => [iri, { name: 'elsewhere' }]);
      },
      {
        limiter: createHostLimiter(4, 2),
        limits: {
          hostFailureThreshold: 1,
          fetchesPerResolver: 2,
        },
      },
    );

    const resolved = await resolver.resolveAll([MAASTRICHT, VENLO]);
    const later = await resolver.resolveAll([ELSEWHERE]);

    expect(asked).toEqual([MAASTRICHT, VENLO]);
    expect(resolved.get(MAASTRICHT)).toEqual({
      outcome: 'unresolved',
      reason: 'resolution failed after 1 attempt(s): HTTP 429',
    });
    expect(later.get(ELSEWHERE)).toMatchObject({ outcome: 'unresolved' });
  });

  it('is recognised as a timeout even when the caller’s own abort error wins the race', async () => {
    // A fetch that rejects the moment its signal aborts, with its own error.
    let attempts = 0;
    const { resolver } = resolverOver(
      (iris, { signal }) => {
        attempts++;
        if (attempts > 1) {
          return Promise.resolve(iris.map((iri) => [iri, { name: 'a place' }]));
        }
        return new Promise((_resolve, reject) => {
          signal.addEventListener('abort', () =>
            reject(
              new DOMException('This operation was aborted', 'AbortError'),
            ),
          );
        });
      },
      { limits: { timeoutMs: 5 } },
    );

    const resolved = await resolver.resolveAll([MAASTRICHT]);

    expect(attempts).toBe(2);
    expect(resolved.get(MAASTRICHT)).toMatchObject({ outcome: 'resolved' });
  });

  it('is recognised when it comes from another copy of this package', async () => {
    // A pruned or nested install can load the package twice; a failure made by
    // one copy must not be stored as a fact by the other.
    const otherCopy: typeof import('../src/failures.js') =
      // @ts-expect-error – the query string makes Vite load a second copy, which
      // TypeScript cannot resolve.
      await import('../src/failures.js?other-copy');
    expect(otherCopy.referenceFailure).not.toBe(referenceFailure);
    let attempts = 0;
    const { resolver } = resolverOver(async (iris) => {
      attempts++;
      if (attempts === 1) {
        throw new otherCopy.RetryableError('HTTP 429', { retryAfterMs: 1 });
      }
      return iris.map((iri) => [iri, otherCopy.referenceFailure('HTTP 500')]);
    });

    const resolved = await resolver.resolveAll([MAASTRICHT]);

    expect(attempts).toBe(2);
    expect(resolved.get(MAASTRICHT)).toEqual({
      outcome: 'unresolved',
      reason: 'HTTP 500',
    });
  });

  it('backs off on its own when the source names no delay', async () => {
    const attemptedAt: number[] = [];
    const { resolver } = resolverOver(async (iris) => {
      attemptedAt.push(Date.now());
      if (attemptedAt.length === 1) {
        throw new RetryableError('HTTP 429');
      }
      return iris.map((iri) => [iri, { name: 'Maastricht' }]);
    });

    const resolved = await resolver.resolveAll([MAASTRICHT]);

    expect(resolved.get(MAASTRICHT)).toMatchObject({ outcome: 'resolved' });
    expect(attemptedAt[1] - attemptedAt[0]).toBeGreaterThanOrEqual(495);
  });

  it('pauses the whole host for as long as the source asked, not just the one reference', async () => {
    // A rate limit is about this client: the other slot sending on regardless
    // would earn the same 429.
    const third = 'https://sws.geonames.org/3/';
    const startedAt = new Map<string, number>();
    let rateLimited = false;
    const began = Date.now();
    const { resolver } = resolverOver(
      async (iris) => {
        const [iri] = iris;
        if (!startedAt.has(iri)) {
          startedAt.set(iri, Date.now() - began);
        }
        if (iri === MAASTRICHT && !rateLimited) {
          rateLimited = true;
          throw new RetryableError('HTTP 429', { retryAfterMs: 100 });
        }
        return iris.map((each) => [each, { name: 'a place' }]);
      },
      { limiter: createHostLimiter(4, 2) },
    );

    const resolved = await resolver.resolveAll([MAASTRICHT, VENLO, third]);

    expect(resolved.get(third)).toMatchObject({ outcome: 'resolved' });
    // Venlo went out beside Maastricht; the third waited for the pause to end.
    expect(startedAt.get(third)).toBeGreaterThanOrEqual(95);
  });
});

describe('a failure of one reference', () => {
  it('fails that reference alone, reported, while the rest of its batch resolves', async () => {
    // A IIIF Collection tagged as a manifest answers 200 and will not improve.
    const { resolver, failures } = resolverOver(
      async (iris) =>
        iris.map((iri) => [
          iri,
          iri === VENLO
            ? referenceFailure('not a manifest')
            : { name: 'Maastricht' },
        ]),
      { limits: { batchSize: 2 } },
    );

    const resolved = await resolver.resolveAll([MAASTRICHT, VENLO]);

    expect(resolved.get(MAASTRICHT)).toMatchObject({ outcome: 'resolved' });
    expect(resolved.get(VENLO)).toEqual({
      outcome: 'unresolved',
      reason: 'not a manifest',
    });
    expect(failures).toEqual([
      { key: VENLO, reason: 'not a manifest', degradedToStore: false },
    ]);
  });

  it('keeps the stored fact rather than overwriting it, and is asked again next run', async () => {
    const store = storeHolding(
      { [MAASTRICHT]: { name: 'Maastricht' } },
      '2020-01-01T00:00:00.000Z',
    );
    const fetch = vi.fn(async (iris: readonly string[]) =>
      iris.map((iri): [string, ReferenceFailure] => [
        iri,
        referenceFailure('HTTP 403'),
      ]),
    );
    const { resolver } = resolverOver(fetch, { store, limits: { ttlMs: 1 } });

    const resolved = await resolver.resolveAll([MAASTRICHT]);
    await resolver.resolveAll([MAASTRICHT]);

    expect(resolved.get(MAASTRICHT)).toMatchObject({
      outcome: 'resolved',
      fact: { name: 'Maastricht' },
      fromStore: true,
    });
    expect((await store.get([MAASTRICHT])).get(MAASTRICHT)).toMatchObject({
      status: 'present',
      fetchedAt: '2020-01-01T00:00:00.000Z',
    });
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it('never writes the host off, however many there are', async () => {
    // A run of broken images says nothing about the images that work.
    const asked: string[] = [];
    const { resolver } = resolverOver(
      async (iris) => {
        asked.push(...iris);
        return iris.map((iri) => [iri, referenceFailure('HTTP 500')]);
      },
      { limiter: createHostLimiter(4, 1), limits: { hostFailureThreshold: 1 } },
    );

    await resolver.resolveAll([
      MAASTRICHT,
      VENLO,
      'https://sws.geonames.org/1/',
    ]);

    expect(asked).toHaveLength(3);
  });
});

describe('parseRetryAfter', () => {
  const now = new Date('2026-11-10T10:00:00.000Z');

  it('reads a number of seconds', () => {
    expect(parseRetryAfter('120', now)).toBe(120_000);
  });

  it('reads an HTTP date as the time left until it', () => {
    expect(parseRetryAfter('Tue, 10 Nov 2026 10:00:30 GMT', now)).toBe(30_000);
  });

  it('reads a date already past as no wait at all', () => {
    expect(parseRetryAfter('Tue, 10 Nov 2026 09:59:00 GMT', now)).toBe(0);
  });

  it('answers nothing for a missing or unreadable header', () => {
    // `Headers.get` answers null for a header that is not there.
    expect(parseRetryAfter(null, now)).toBeUndefined();
    expect(parseRetryAfter('soon', now)).toBeUndefined();
    expect(parseRetryAfter('-5', now)).toBeUndefined();
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
      },
    );

    const resolved = await resolver.resolveAll([MAASTRICHT]);

    expect(resolved.get(MAASTRICHT)).toMatchObject({ outcome: 'unresolved' });
  });
});

describe('an attempt that outruns its deadline', () => {
  it('fails rather than hanging the run, once its second attempt times out too', async () => {
    let attempts = 0;
    const { resolver, failures } = resolverOver(
      // Never settles on its own: without a deadline, resolveAll never returns.
      () => {
        attempts++;
        return new Promise(() => undefined);
      },
      { limits: { timeoutMs: 5 } },
    );

    const resolved = await resolver.resolveAll([MAASTRICHT]);

    expect(attempts).toBe(2);
    expect(resolved.get(MAASTRICHT)).toMatchObject({
      outcome: 'unresolved',
      reason: 'resolution failed after 2 attempt(s): timed out after 5ms',
    });
    expect(failures).toHaveLength(1);
  });

  it('is tried once more at the back of the queue, so a passing stall costs no reference', async () => {
    // A manifest that stalled for 30 s answered in under a second on the next pass.
    const asked: string[] = [];
    const { resolver, failures } = resolverOver(
      async (iris) => {
        asked.push(...iris);
        if (iris.includes(MAASTRICHT) && asked.length === 1) {
          return new Promise(() => undefined);
        }
        return iris.map((iri) => [iri, { name: 'a place' }]);
      },
      { limiter: createHostLimiter(4, 1), limits: { timeoutMs: 20 } },
    );

    const resolved = await resolver.resolveAll([MAASTRICHT, VENLO]);

    expect(asked).toEqual([MAASTRICHT, VENLO, MAASTRICHT]);
    expect(resolved.get(MAASTRICHT)).toMatchObject({ outcome: 'resolved' });
    expect(failures).toEqual([]);
  });

  it('spends no second unit of the budget on its second attempt', async () => {
    // The budget counts references, so a stall does not cost a cold store the
    // reference behind it.
    let stalled = false;
    const { resolver } = resolverOver(
      async (iris) => {
        if (!stalled) {
          stalled = true;
          return new Promise(() => undefined);
        }
        return iris.map((iri) => [iri, { name: 'a place' }]);
      },
      { limits: { timeoutMs: 5, fetchesPerResolver: 2 } },
    );

    await resolver.resolveAll([MAASTRICHT]);
    const second = await resolver.resolveAll([VENLO]);

    expect(second.get(VENLO)).toMatchObject({ outcome: 'resolved' });
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
      { limits: { timeoutMs: 5 } },
    );

    await resolver.resolveAll([MAASTRICHT]);

    expect(aborted).toBe(true);
  });
});

describe('counting', () => {
  /** Resolve `references`, answering with how often each count was called. */
  async function countsOf(
    resolver: ReturnType<typeof resolverOver>['resolver'],
    references: readonly string[],
  ): Promise<Record<string, number>> {
    const counts: Record<string, number> = {};
    await resolver.resolveAll(references, {
      count: (name) => {
        counts[name] = (counts[name] ?? 0) + 1;
      },
    });
    return counts;
  }

  it('counts each reference by where its answer came from', async () => {
    const { resolver } = resolverOver(
      // ELSEWHERE is left out of the answer: the source has none.
      async (iris) =>
        iris
          .filter((iri) => iri !== ELSEWHERE)
          .map((iri): [string, Place] => [iri, { name: 'fetched' }]),
      {
        store: storeHolding(
          { [VENLO]: { name: 'stored' } },
          '2026-01-01T00:00:00.000Z',
        ),
      },
    );

    expect(await countsOf(resolver, [MAASTRICHT, VENLO, ELSEWHERE])).toEqual({
      fetched: 1,
      'from store': 1,
      absent: 1,
    });
  });

  it('counts a failed fetch and a reference the budget deferred', async () => {
    const { resolver } = resolverOver(
      async () => {
        throw new Error('HTTP 500');
      },
      { limits: { fetchesPerResolver: 1 } },
    );

    expect(await countsOf(resolver, [MAASTRICHT, VENLO])).toEqual({
      failed: 1,
      deferred: 1,
    });
  });

  it('counts a reference written off with its host apart from a failed one', async () => {
    const { resolver } = resolverOver(
      async () => {
        throw new Error('connection refused');
      },
      {
        limiter: createHostLimiter(4, 1),
        limits: {
          batchSize: 1,
          hostFailureThreshold: 2,
        },
      },
    );

    expect(
      await countsOf(resolver, [
        MAASTRICHT,
        VENLO,
        'https://sws.geonames.org/1/',
        'https://sws.geonames.org/2/',
      ]),
    ).toEqual({ failed: 2, 'written off': 2 });
  });

  it('counts a failed refresh that a stored fact stood in for as failed', async () => {
    const { resolver } = resolverOver(
      async () => {
        throw new Error('HTTP 500');
      },
      {
        store: storeHolding(
          { [VENLO]: { name: 'stored' } },
          '2020-01-01T00:00:00.000Z',
        ),
        limits: { ttlMs: 1 },
      },
    );

    expect(await countsOf(resolver, [VENLO])).toEqual({ failed: 1 });
  });

  it('counts a stale fact the budget left unrefreshed as deferred', async () => {
    const { resolver } = resolverOver(
      async (iris) =>
        iris.map((iri): [string, Place] => [iri, { name: 'fetched' }]),
      {
        store: storeHolding(
          { [VENLO]: { name: 'stored' } },
          '2020-01-01T00:00:00.000Z',
        ),
        limits: { ttlMs: 1, fetchesPerResolver: 1 },
      },
    );

    expect(await countsOf(resolver, [MAASTRICHT, VENLO])).toEqual({
      fetched: 1,
      deferred: 1,
    });
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
        limiter: createHostLimiter(4, 1),
        limits: {
          batchSize: 1,
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

  it('is written off when most of its references fail, even with successes in between', async () => {
    // A host where most references time out, and a few answer in between, used
    // to reset a count of consecutive failures and was never written off.
    const asked: string[] = [];
    const { resolver } = resolverOver(
      async (iris) => {
        asked.push(...iris);
        if (asked.length % 3 !== 2) {
          throw new Error('HTTP 502');
        }
        return iris.map((iri) => [iri, { name: 'a place' }]);
      },
      { limiter: createHostLimiter(4, 1), limits: { hostFailureThreshold: 5 } },
    );

    await resolver.resolveAll(
      Array.from(
        { length: 12 },
        (_, index) => `https://sws.geonames.org/${index}/`,
      ),
    );

    // Fail, succeed, fail, fail, succeed, fail, fail: the fifth failure among
    // the last ten writes the host off, and the other five are never sent.
    expect(asked).toHaveLength(7);
  });

  it('forgives a stall whose second attempt succeeds', async () => {
    // A slow moment, not a dead host: once Maastricht answers on its second
    // attempt, its timeout must not help write the host off later.
    const third = 'https://sws.geonames.org/3/';
    const attempted = new Set<string>();
    const { resolver } = resolverOver(
      (iris) => {
        const [iri] = iris;
        const first = !attempted.has(iri);
        attempted.add(iri);
        if (first && iri !== VENLO) {
          return new Promise(() => undefined);
        }
        return Promise.resolve(iris.map((each) => [each, { name: 'a place' }]));
      },
      {
        limiter: createHostLimiter(4, 1),
        limits: {
          timeoutMs: 5,
          hostFailureThreshold: 2,
        },
      },
    );

    await resolver.resolveAll([MAASTRICHT, VENLO]);
    const later = await resolver.resolveAll([third]);

    // Without forgiveness the window would hold two timeouts by now, and the
    // third reference would be written off before its second attempt.
    expect(later.get(third)).toMatchObject({ outcome: 'resolved' });
  });

  it('forgives each recovered stall once, and only its own', async () => {
    // Maastricht and Venlo both stall; only Maastricht recovers. The window
    // must keep Venlo’s failure, so two more stalls make three and write the
    // host off before either gets its second attempt.
    const third = 'https://sws.geonames.org/3/';
    const fourth = 'https://sws.geonames.org/4/';
    const fifth = 'https://sws.geonames.org/5/';
    const attempted = new Set<string>();
    const asked: string[] = [];
    const { resolver } = resolverOver(
      (iris) => {
        const [iri] = iris;
        asked.push(iri);
        const first = !attempted.has(iri);
        attempted.add(iri);
        if (
          [VENLO, fourth, fifth].includes(iri) ||
          (first && iri === MAASTRICHT)
        ) {
          return new Promise(() => undefined);
        }
        return Promise.resolve(iris.map((each) => [each, { name: 'a place' }]));
      },
      {
        limiter: createHostLimiter(4, 1),
        limits: {
          timeoutMs: 5,
          hostFailureThreshold: 3,
        },
      },
    );

    await resolver.resolveAll([MAASTRICHT, VENLO, third]);
    await resolver.resolveAll([fourth, fifth]);

    expect(asked.filter((iri) => iri === fourth)).toHaveLength(1);
    expect(asked.filter((iri) => iri === fifth)).toHaveLength(1);
  });

  it('resolves a recovered stall whose failure has already left the window', async () => {
    // A window of four: the four successes queued behind Maastricht push its
    // timeout out before its second attempt comes round.
    const attempted = new Set<string>();
    const { resolver } = resolverOver(
      (iris) => {
        const [iri] = iris;
        const first = !attempted.has(iri);
        attempted.add(iri);
        if (first && iri === MAASTRICHT) {
          return new Promise(() => undefined);
        }
        return Promise.resolve(iris.map((each) => [each, { name: 'a place' }]));
      },
      {
        limiter: createHostLimiter(4, 1),
        limits: {
          timeoutMs: 5,
          hostFailureThreshold: 2,
        },
      },
    );

    const resolved = await resolver.resolveAll([
      MAASTRICHT,
      ...Array.from(
        { length: 4 },
        (_, index) => `https://sws.geonames.org/${index}/`,
      ),
    ]);

    expect(resolved.get(MAASTRICHT)).toMatchObject({ outcome: 'resolved' });
  });

  it('takes back no failure for a stall that was never counted', async () => {
    const asked: string[] = [];
    let stallAttempts = 0;
    const host = 'https://sws.geonames.org';
    const limiter = createHostLimiter(4, 2);
    const { resolver } = resolverOver(
      async (iris, { signal }) => {
        asked.push(...iris);
        if (iris.some((iri) => iri.includes('/ok/'))) {
          return iris.map((iri) => [iri, { name: 'a place' }]);
        }
        if (iris.includes(`${host}/stall/`) && stallAttempts++ === 0) {
          return new Promise((_resolve, reject) =>
            signal.addEventListener('abort', () => reject(signal.reason)),
          );
        }
        if (iris.includes(`${host}/stall/`)) {
          return iris.map((iri) => [iri, { name: 'a place' }]);
        }
        throw new Error('HTTP 502');
      },
      { limiter, limits: { timeoutMs: 5, hostFailureThreshold: 2 } },
    );

    await resolver.resolveAll([`${host}/first/`]); // Counted, at a limit of 1.
    await resolver.resolveAll([`${host}/ok/1/`, `${host}/ok/2/`]);
    expect(limiter.limitOf('sws.geonames.org')).toBe(2);
    // Stalls at a limit of 2, so not counted; its second attempt is answered.
    await resolver.resolveAll([`${host}/stall/`]);
    await resolver.resolveAll([`${host}/second/`]); // Counted: two, written off.
    await resolver.resolveAll([`${host}/never/`]);

    expect(asked).not.toContain(`${host}/never/`);
  });

  it('slows a failing host down to one batch at a time before writing it off', async () => {
    let failing = false;
    const asked: string[] = [];
    const limiter = createHostLimiter(4, 2);
    const { resolver } = resolverOver(
      async (iris) => {
        if (!failing) {
          return iris.map((iri) => [iri, { name: 'a place' }]);
        }
        asked.push(...iris);
        throw new Error('HTTP 502');
      },
      { limiter, limits: { hostFailureThreshold: 1 } },
    );
    // A host that kept up has earned two batches in flight.
    await resolver.resolveAll(
      [1, 2, 3].map((index) => `https://sws.geonames.org/warm/${index}/`),
    );
    expect(limiter.limitOf('sws.geonames.org')).toBe(2);
    failing = true;

    await resolver.resolveAll([
      MAASTRICHT,
      VENLO,
      'https://sws.geonames.org/1/',
      'https://sws.geonames.org/2/',
    ]);

    // Maastricht and Venlo fail at two in flight: one overload, which halves
    // the limit and writes nothing off. The first failure at one batch at a
    // time does, so the last reference is never sent.
    expect(asked).toEqual([MAASTRICHT, VENLO, 'https://sws.geonames.org/1/']);
    expect(limiter.limitOf('sws.geonames.org')).toBe(1);
  });

  it('gives a stall no second attempt once its host is written off, nor a refund', async () => {
    // Maastricht stalls and waits at the back of the queue; Venlo’s 502 then
    // writes the host off. Maastricht was sent once, so it keeps its charge and
    // the reason it actually failed for.
    const asked: string[] = [];
    const { resolver } = resolverOver(
      async (iris) => {
        asked.push(...iris);
        if (iris.includes(MAASTRICHT)) {
          return new Promise(() => undefined);
        }
        if (iris.includes(VENLO)) {
          throw new Error('HTTP 502');
        }
        return iris.map((iri) => [iri, { name: 'elsewhere' }]);
      },
      {
        limiter: createHostLimiter(4, 1),
        limits: {
          timeoutMs: 5,
          hostFailureThreshold: 2,
          fetchesPerResolver: 2,
        },
      },
    );

    const resolved = await resolver.resolveAll([MAASTRICHT, VENLO]);
    const later = await resolver.resolveAll([ELSEWHERE]);

    expect(asked).toEqual([MAASTRICHT, VENLO]);
    expect(resolved.get(MAASTRICHT)).toEqual({
      outcome: 'unresolved',
      reason: 'resolution failed after 1 attempt(s): timed out after 5ms',
    });
    expect(later.get(ELSEWHERE)).toMatchObject({ outcome: 'unresolved' });
  });

  it('is written off while it times out, not after every reference has had its turn', async () => {
    // A host that drops packets: waiting for each timeout’s second attempt
    // before counting it would cost every reference one full timeout first.
    const asked: string[] = [];
    const { resolver } = resolverOver(
      (iris) => {
        asked.push(...iris);
        return new Promise(() => undefined);
      },
      {
        limiter: createHostLimiter(4, 1),
        limits: {
          timeoutMs: 5,
          hostFailureThreshold: 2,
        },
      },
    );

    await resolver.resolveAll(
      Array.from(
        { length: 6 },
        (_, index) => `https://sws.geonames.org/${index}/`,
      ),
    );

    expect(asked).toHaveLength(2);
  });

  it('forgets a failure that has slid out of its window', async () => {
    // One failure in every four batches, against a threshold of two in the last
    // four: an imperfect host, not a dead one.
    const asked: string[] = [];
    const { resolver } = resolverOver(
      async (iris) => {
        asked.push(...iris);
        if (asked.length % 4 === 1) {
          throw new Error('HTTP 502');
        }
        return iris.map((iri) => [iri, { name: 'a place' }]);
      },
      { limiter: createHostLimiter(4, 1), limits: { hostFailureThreshold: 2 } },
    );

    await resolver.resolveAll(
      Array.from(
        { length: 12 },
        (_, index) => `https://sws.geonames.org/${index}/`,
      ),
    );

    expect(asked).toHaveLength(12);
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
        limiter: createHostLimiter(4, 1),
        limits: {
          batchSize: 1,
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
        // One batch per host at a time, so nothing else is already in flight when the
        // first failure settles.
        limiter: createHostLimiter(4, 1),
        limits: {
          batchSize: 1,
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
      limits: { batchSize: 1, hostFailureThreshold: 2 },
    });
    await first.resolver.resolveAll([MAASTRICHT, VENLO]);

    down = false;
    const second = resolverOver(fetchFrom(), {
      store,
      limits: { batchSize: 1, hostFailureThreshold: 2 },
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
      { limiter: createHostLimiter(10, 1), limits: { batchSize: 1 } },
    );

    await resolver.resolveAll([MAASTRICHT, VENLO]);

    expect(peak).toBe(1);
  });

  it('holds the per-host cap across concurrent resolveAll calls', async () => {
    // A stage runs batches in parallel, each transform calling resolveAll on
    // one resolver, so the cap has to span the calls to mean anything.
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
      { limiter: createHostLimiter(10, 2) },
    );

    await Promise.all(
      [0, 1, 2, 3].map((call) =>
        resolver.resolveAll([
          `https://example.org/${call}/a`,
          `https://example.org/${call}/b`,
        ]),
      ),
    );

    expect(peak).toBe(2);
  });

  it('holds the global cap across concurrent resolveAll calls', async () => {
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
      { limiter: createHostLimiter(3, 2) },
    );

    await Promise.all(
      [0, 1, 2, 3].map((call) =>
        resolver.resolveAll([
          `https://host-${call}.example.org/a`,
          `https://host-${call}.example.org/b`,
        ]),
      ),
    );

    expect(peak).toBe(3);
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
      { limiter: createHostLimiter(10, 1), limits: { batchSize: 1 } },
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
        limiter: createHostLimiter(10, 1),
        limits: { batchSize: 10 },
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
