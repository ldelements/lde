import { describe, expect, it, vi } from 'vitest';
import type { Client } from 'typesense';
import type { SearchType } from '@lde/search';
import { BlueGreenRebuild } from '../src/blue-green-rebuild.js';
import { InPlaceRebuild } from '../src/in-place-rebuild.js';
import { makeRunContext, typesenseError } from './helpers.js';

// Error-path specs that would need fault injection against a real server:
// the writers must release the cross-pod lock when opening the run fails
// midway, and must not sweep blind when the source facet hits its cap.

const searchType: SearchType = {
  name: 'Object',
  type: 'https://example.org/Object',
  fields: [{ name: 'title', kind: 'keyword' }],
};

/**
 * A fake of the client surface the writers use. The lock always acquires;
 * spies record lock releases and document deletions.
 */
function fakeClient(behaviour: {
  /** Creating a data collection (the blue collection / in-place collection). */
  createDataCollection?: () => Promise<unknown>;
  /** Retrieving a data collection (in-place existence probe). */
  retrieveDataCollection?: () => Promise<unknown>;
  /** The `source` facet counts a search returns. */
  facetCounts?: { value: string; count: number }[];
}) {
  const releasedLocks = vi.fn().mockResolvedValue({});
  const deletedFilters = vi.fn().mockResolvedValue({});
  const client = {
    aliases: () => ({
      retrieve: () => Promise.reject(typesenseError(404)),
      upsert: () => Promise.resolve({}),
    }),
    collections: (name?: string) => {
      if (name === undefined) {
        return {
          create: (schema: { name: string }) =>
            schema.name === 'rebuild_locks'
              ? Promise.resolve({})
              : (
                  behaviour.createDataCollection ?? (() => Promise.resolve({}))
                )(),
        };
      }
      if (name === 'rebuild_locks') {
        return {
          retrieve: () => Promise.resolve({}),
          documents: (id?: string) =>
            id === undefined
              ? { create: () => Promise.resolve({}) }
              : { delete: releasedLocks },
        };
      }
      return {
        retrieve:
          behaviour.retrieveDataCollection ?? (() => Promise.resolve({})),
        delete: () => Promise.resolve({}),
        documents: (id?: string) =>
          id === undefined
            ? {
                import: () => Promise.resolve([]),
                search: () =>
                  Promise.resolve({
                    facet_counts: [{ counts: behaviour.facetCounts ?? [] }],
                  }),
                delete: deletedFilters,
              }
            : { delete: releasedLocks },
      };
    },
  } as unknown as Client;
  return { client, releasedLocks, deletedFilters };
}

describe('BlueGreenRebuild error paths', () => {
  it('releases the lock when creating the fresh collection fails', async () => {
    const { client, releasedLocks } = fakeClient({
      createDataCollection: () => Promise.reject(typesenseError(500)),
    });
    const writer = new BlueGreenRebuild(client, searchType, {
      name: 'datasets',
    });

    await expect(writer.openRun(makeRunContext())).rejects.toThrow('HTTP 500');
    expect(releasedLocks).toHaveBeenCalledOnce();
  });
});

describe('InPlaceRebuild error paths', () => {
  it('releases the lock when probing the collection fails', async () => {
    const { client, releasedLocks } = fakeClient({
      retrieveDataCollection: () => Promise.reject(typesenseError(500)),
    });
    const writer = new InPlaceRebuild(client, searchType, { name: 'objects' });

    await expect(writer.openRun(makeRunContext())).rejects.toThrow('HTTP 500');
    expect(releasedLocks).toHaveBeenCalledOnce();
  });

  it('refuses a membership sweep beyond the source facet cap', async () => {
    // A truncated facet would silently miss departed sources; the writer
    // throws instead of sweeping blind.
    const { client, deletedFilters } = fakeClient({
      facetCounts: Array.from({ length: 10_000 }, (_, index) => ({
        value: `http://example.org/dataset/${index}`,
        count: 1,
      })),
    });
    const writer = new InPlaceRebuild(client, searchType, { name: 'objects' });

    const run = await writer.openRun(makeRunContext());
    await expect(run.commit()).rejects.toThrow(/10000 distinct sources/);
    expect(deletedFilters).not.toHaveBeenCalled();
  });
});
