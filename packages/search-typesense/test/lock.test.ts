import { describe, expect, it, vi } from 'vitest';
import type { Client } from 'typesense';
import { acquireLock, releaseLock } from '../src/lock.js';
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

    expect(acquired).toBe(true);
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

    expect(acquired).toBe(true);
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

    expect(acquired).toBe(false);
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

describe('releaseLock', () => {
  it('tolerates a lock that is not held', async () => {
    await expect(
      releaseLock(
        fakeClient({
          deleteDocument: () => Promise.reject(typesenseError(404)),
        }),
        'datasets',
      ),
    ).resolves.toBeUndefined();
  });

  it('rethrows an unexpected error', async () => {
    await expect(
      releaseLock(
        fakeClient({
          deleteDocument: () => Promise.reject(typesenseError(500)),
        }),
        'datasets',
      ),
    ).rejects.toThrow('HTTP 500');
  });
});
