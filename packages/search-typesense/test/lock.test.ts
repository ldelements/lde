import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Client } from 'typesense';
import { acquireLock, type HeldLock } from '../src/lock.js';
import { typesenseError } from './helpers.js';

/**
 * A minimal fake of the collections/documents client surface the lock uses.
 * Configure each call site’s behaviour; unconfigured calls resolve.
 */
function fakeClient(behaviour: {
  retrieveCollection?: () => Promise<unknown>;
  createCollection?: () => Promise<unknown>;
  createDocument?: () => Promise<unknown>;
  retrieveDocument?: () => Promise<unknown>;
  upsertDocument?: () => Promise<unknown>;
  deleteDocument?: () => Promise<unknown>;
}): Client {
  const resolve = () => Promise.resolve({});
  return {
    collections: (name?: string) =>
      name === undefined
        ? { create: behaviour.createCollection ?? resolve }
        : {
            retrieve: behaviour.retrieveCollection ?? resolve,
            documents: (id?: string) =>
              id === undefined
                ? {
                    create: behaviour.createDocument ?? resolve,
                    upsert: behaviour.upsertDocument ?? resolve,
                  }
                : {
                    retrieve: behaviour.retrieveDocument ?? resolve,
                    delete: behaviour.deleteDocument ?? resolve,
                  },
          },
  } as unknown as Client;
}

describe('acquireLock', () => {
  it('takes the lock in a single request when the collection exists', async () => {
    const createCollection = vi.fn().mockResolvedValue({});
    const createDocument = vi.fn().mockResolvedValue({});

    const acquired = await acquireLock(
      fakeClient({ createCollection, createDocument }),
      'datasets',
      1000,
    );

    expect(acquired).toBeDefined();
    expect(createDocument).toHaveBeenCalledOnce();
    expect(createCollection).not.toHaveBeenCalled();
  });

  it('creates the lock collection on first use, tolerating a concurrent creator', async () => {
    // The first take 404s (no collection yet); the concurrent-creator 409 is
    // tolerated and the lock is retaken from the top.
    const createCollection = vi.fn().mockRejectedValue(typesenseError(409));
    const createDocument = vi
      .fn()
      .mockRejectedValueOnce(typesenseError(404))
      .mockResolvedValueOnce({});

    const acquired = await acquireLock(
      fakeClient({
        retrieveCollection: () => Promise.reject(typesenseError(404)),
        createCollection,
        createDocument,
      }),
      'datasets',
      1000,
    );

    expect(acquired).toBeDefined();
    expect(createCollection).toHaveBeenCalledOnce();
    expect(createDocument).toHaveBeenCalledTimes(2);
  });

  it('rethrows an unexpected error from creating the lock collection', async () => {
    await expect(
      acquireLock(
        fakeClient({
          createDocument: () => Promise.reject(typesenseError(404)),
          retrieveCollection: () => Promise.reject(typesenseError(500)),
        }),
        'datasets',
        1000,
      ),
    ).rejects.toThrow('HTTP 500');
  });

  it('rethrows an unexpected error from taking the lock', async () => {
    await expect(
      acquireLock(
        fakeClient({
          createDocument: () => Promise.reject(typesenseError(503)),
        }),
        'datasets',
        1000,
      ),
    ).rejects.toThrow('HTTP 503');
  });

  it('reports the lock as taken when the holder releases it mid-acquire', async () => {
    // The create conflicts, but by the time we read the holder it is gone:
    // leave the race for the next attempt instead of stealing in.
    const acquired = await acquireLock(
      fakeClient({
        createDocument: () => Promise.reject(typesenseError(409)),
        retrieveDocument: () => Promise.reject(typesenseError(404)),
      }),
      'datasets',
      1000,
    );

    expect(acquired).toBeUndefined();
  });

  it('rethrows an unexpected error from reading the current holder', async () => {
    await expect(
      acquireLock(
        fakeClient({
          createDocument: () => Promise.reject(typesenseError(409)),
          retrieveDocument: () => Promise.reject(typesenseError(500)),
        }),
        'datasets',
        1000,
      ),
    ).rejects.toThrow('HTTP 500');
  });
});

/**
 * A fake lock store that keeps the lock document, so a run can take, refresh,
 * lose and release it like it would against Typesense.
 */
function statefulClient() {
  const store = new Map<string, Record<string, unknown>>();
  const client = {
    collections: () => ({
      documents: (id?: string) =>
        id === undefined
          ? {
              create: async (document: { id: string }) => {
                if (store.has(document.id)) {
                  throw typesenseError(409);
                }
                store.set(document.id, document);
              },
              upsert: async (document: { id: string }) => {
                store.set(document.id, document);
              },
            }
          : {
              retrieve: async () => {
                const document = store.get(id);
                if (document === undefined) {
                  throw typesenseError(404);
                }
                return document;
              },
              delete: async () => {
                if (!store.delete(id)) {
                  throw typesenseError(404);
                }
              },
            },
    }),
  } as unknown as Client;
  /** Another run takes the lock over, as a reclaim would. */
  const takeOver = (name: string) =>
    store.set(name, {
      id: name,
      owner: 'another run',
      acquired_at: Date.now(),
    });
  return { client, store, takeOver };
}

async function heldLock(client: Client, ttlMs = 3000): Promise<HeldLock> {
  const lock = await acquireLock(client, 'datasets', ttlMs);
  if (lock === undefined) {
    throw new Error('Expected to take the lock');
  }
  return lock;
}

describe('a held lock', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('is refreshed while the run is open, so it never goes stale', async () => {
    const { client } = statefulClient();
    const lock = await heldLock(client);

    // Far past the TTL: a holder that did not refresh would be reclaimed.
    await vi.advanceTimersByTimeAsync(10_000);

    expect(await acquireLock(client, 'datasets', 3000)).toBeUndefined();
    await lock.release();
  });

  it('is reclaimed once its holder stops refreshing it', async () => {
    const { client } = statefulClient();
    await heldLock(client);
    vi.clearAllTimers(); // the holder dies without releasing

    await vi.advanceTimersByTimeAsync(3001);

    expect(await acquireLock(client, 'datasets', 3000)).toBeDefined();
  });

  it('stops refreshing once released', async () => {
    const { client, store } = statefulClient();
    const lock = await heldLock(client);

    await lock.release();
    await vi.advanceTimersByTimeAsync(10_000);

    expect(store.has('datasets')).toBe(false);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('stops refreshing once another run took it over', async () => {
    const { client, store, takeOver } = statefulClient();
    await heldLock(client);
    takeOver('datasets');

    await vi.advanceTimersByTimeAsync(10_000);

    expect(store.get('datasets')).toMatchObject({ owner: 'another run' });
    expect(vi.getTimerCount()).toBe(0);
  });

  it('keeps refreshing after a failed refresh', async () => {
    const { client, store } = statefulClient();
    const lock = await heldLock(client);
    const retrieve = vi.spyOn(store, 'get').mockImplementationOnce(() => {
      throw typesenseError(503);
    });

    await vi.advanceTimersByTimeAsync(10_000);

    expect(retrieve).toHaveBeenCalled();
    expect(await acquireLock(client, 'datasets', 3000)).toBeUndefined();
    await lock.release();
  });

  it('asserts it is still held', async () => {
    const { client } = statefulClient();
    const lock = await heldLock(client);

    await expect(lock.assertHeld()).resolves.toBeUndefined();
    await lock.release();
  });

  it('refuses to go live once another run took it over', async () => {
    const { client, takeOver } = statefulClient();
    const lock = await heldLock(client);
    takeOver('datasets');

    await expect(lock.assertHeld()).rejects.toThrow(
      /Another run took over the rebuild lock on “datasets”/,
    );
    await lock.release();
  });

  it('leaves the lock alone on release once another run took it over', async () => {
    const { client, store, takeOver } = statefulClient();
    const lock = await heldLock(client);
    takeOver('datasets');

    await lock.release();

    expect(store.get('datasets')).toMatchObject({ owner: 'another run' });
  });

  it('tolerates a release after the lock is already gone', async () => {
    const { client, store } = statefulClient();
    const lock = await heldLock(client);
    store.delete('datasets');

    await expect(lock.release()).resolves.toBeUndefined();
  });

  it('rethrows an unexpected error on release', async () => {
    const { client, store } = statefulClient();
    const lock = await heldLock(client);
    vi.spyOn(store, 'delete').mockImplementation(() => {
      throw typesenseError(500);
    });

    await expect(lock.release()).rejects.toThrow('HTTP 500');
  });
});
