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

  it('stays committed when releasing the lock fails after the alias swap', async () => {
    const { client, releasedLocks } = fakeClient({});
    // The alias has already swapped (the new collection is live); only the
    // post-swap lock release then fails.
    releasedLocks.mockRejectedValue(typesenseError(500));
    const writer = new BlueGreenRebuild(client, searchType, {
      name: 'datasets',
    });

    const run = await writer.openRun(makeRunContext());
    // commit must not reject: a caller that aborts on a rejected commit (the
    // pipeline does) would otherwise drop the collection the alias now points
    // at. The lock is left to its TTL reclaim instead.
    await expect(run.commit()).resolves.toBeUndefined();
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

  // The writer requests `maxSweepableSources + 1` buckets, so the facet
  // returning that many proves more sources exist than it can enumerate and
  // the sweep would miss departed ones. Configured small here so the boundary
  // is exact: a full-but-not-over result must proceed, one-over must throw.
  const sources = (count: number) =>
    Array.from({ length: count }, (_, index) => ({
      value: `http://example.org/dataset/${index}`,
      count: 1,
    }));

  it('sweeps when the source count is exactly the cap (not truncated)', async () => {
    const { client, deletedFilters } = fakeClient({ facetCounts: sources(2) });
    const writer = new InPlaceRebuild(client, searchType, {
      name: 'objects',
      maxSweepableSources: 2,
    });

    const run = await writer.openRun(makeRunContext());
    // Selection is empty, so both indexed sources departed and are swept.
    await expect(run.commit()).resolves.toBeUndefined();
    expect(deletedFilters).toHaveBeenCalled();
  });

  it('refuses a membership sweep when the facet is truncated (one over the cap)', async () => {
    const { client, deletedFilters } = fakeClient({ facetCounts: sources(3) });
    const writer = new InPlaceRebuild(client, searchType, {
      name: 'objects',
      maxSweepableSources: 2,
    });

    const run = await writer.openRun(makeRunContext());
    await expect(run.commit()).rejects.toThrow(/beyond 2 distinct sources/);
    expect(deletedFilters).not.toHaveBeenCalled();
  });
});
