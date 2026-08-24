import { chmod, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createResolver, sqliteFactStore, urlHost } from '../src/index.js';

interface Place {
  name: string;
  latitude: number;
}

const MAASTRICHT = 'https://sws.geonames.org/2751283/';
const VENLO = 'https://sws.geonames.org/2745706/';
const STAMP = '2026-08-24T09:00:00.000Z';
const VERSION = '1';

/** One present fact, as `set()` takes them. */
function present(fact: Place) {
  return { status: 'present', fact } as const;
}

let directory: string;
let path: string;

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), 'lde-resolver-'));
  // A nested path, so the store is also shown to create its own directory.
  path = join(directory, 'store', 'facts.sqlite');
});

afterEach(async () => {
  // Restore anything a test made read-only, or the cleanup cannot unlink it.
  for (const made of [directory, join(directory, 'store'), path]) {
    await chmod(made, 0o755).catch(() => undefined);
  }
  await rm(directory, { recursive: true, force: true });
});

describe('sqliteFactStore', () => {
  it('answers a later reader with what an earlier one wrote', async () => {
    const writer = sqliteFactStore<Place>({ path });
    await writer.set(
      new Map([[MAASTRICHT, present({ name: 'Maastricht', latitude: 50.85 })]]),
      STAMP,
      VERSION,
    );

    // A second store over the same file is the next run: the fact outlives the
    // process that fetched it, which is the whole reason this exists.
    const reader = sqliteFactStore<Place>({ path });
    expect(await reader.get([MAASTRICHT])).toEqual(
      new Map([
        [
          MAASTRICHT,
          {
            status: 'present',
            fact: { name: 'Maastricht', latitude: 50.85 },
            fetchedAt: STAMP,
            version: VERSION,
          },
        ],
      ]),
    );
  });

  it('holds an absence, so a key the source does not know is remembered', async () => {
    const store = sqliteFactStore<Place>({ path });

    await store.set(new Map([[VENLO, { status: 'absent' }]]), STAMP, VERSION);

    expect(await store.get([VENLO])).toEqual(
      new Map([
        [VENLO, { status: 'absent', fetchedAt: STAMP, version: VERSION }],
      ]),
    );
  });

  it('leaves a key it holds nothing for out of the answer', async () => {
    const store = sqliteFactStore<Place>({ path });
    await store.set(
      new Map([[MAASTRICHT, present({ name: 'Maastricht', latitude: 50.85 })]]),
      STAMP,
      VERSION,
    );

    const found = await store.get([MAASTRICHT, VENLO]);

    expect([...found.keys()]).toEqual([MAASTRICHT]);
  });

  it('replaces a fact, its stamp and its version on a rewrite', async () => {
    const store = sqliteFactStore<Place>({ path });
    await store.set(
      new Map([[MAASTRICHT, present({ name: 'old', latitude: 1 })]]),
      STAMP,
      '1',
    );
    await store.set(
      new Map([[MAASTRICHT, present({ name: 'new', latitude: 2 })]]),
      '2026-09-01T00:00:00.000Z',
      '2',
    );

    expect(await store.get([MAASTRICHT])).toEqual(
      new Map([
        [
          MAASTRICHT,
          {
            status: 'present',
            fact: { name: 'new', latitude: 2 },
            fetchedAt: '2026-09-01T00:00:00.000Z',
            version: '2',
          },
        ],
      ]),
    );
  });

  it('replaces a fact with an absence, dropping the fact it held', async () => {
    const store = sqliteFactStore<Place>({ path });
    await store.set(
      new Map([[MAASTRICHT, present({ name: 'Maastricht', latitude: 1 })]]),
      STAMP,
      VERSION,
    );

    await store.set(
      new Map([[MAASTRICHT, { status: 'absent' }]]),
      '2026-09-01T00:00:00.000Z',
      VERSION,
    );

    expect(await store.get([MAASTRICHT])).toEqual(
      new Map([
        [
          MAASTRICHT,
          {
            status: 'absent',
            fetchedAt: '2026-09-01T00:00:00.000Z',
            version: VERSION,
          },
        ],
      ]),
    );
  });

  it('forgets a purged key', async () => {
    const store = sqliteFactStore<Place>({ path });
    await store.set(
      new Map([[MAASTRICHT, present({ name: 'Maastricht', latitude: 1 })]]),
      STAMP,
      VERSION,
    );

    await store.purge([MAASTRICHT]);

    expect(await store.get([MAASTRICHT])).toEqual(new Map());
  });

  it('does nothing at all for an empty read, write or purge', async () => {
    const store = sqliteFactStore<Place>({ path });

    expect(await store.get([])).toEqual(new Map());
    await expect(store.set(new Map(), STAMP, VERSION)).resolves.toBeUndefined();
    await expect(store.purge([])).resolves.toBeUndefined();
  });

  it('keeps two key spaces apart in one file', async () => {
    const places = sqliteFactStore<Place>({ path, table: 'places' });
    const images = sqliteFactStore<Place>({ path, table: 'images' });

    await places.set(
      new Map([[MAASTRICHT, present({ name: 'Maastricht', latitude: 1 })]]),
      STAMP,
      VERSION,
    );

    expect(await images.get([MAASTRICHT])).toEqual(new Map());
  });

  it('refuses a table name that is not a plain identifier', () => {
    // The table cannot be a bound parameter, so it is the one interpolated
    // string – and therefore the one that is checked.
    expect(() =>
      sqliteFactStore<Place>({ path, table: 'facts; DROP TABLE facts' }),
    ).toThrow('must be letters, digits and underscores');
  });

  it('reports a location it cannot even create from check()', async () => {
    const store = sqliteFactStore<Place>({
      // A path under a file, so creating the directory fails.
      path: join(directory, 'not-a-directory'),
      table: 'facts',
    });
    await store.set(
      new Map([[MAASTRICHT, present({ name: 'x', latitude: 1 })]]),
      STAMP,
      VERSION,
    );
    const blocked = sqliteFactStore<Place>({
      path: join(directory, 'not-a-directory', 'nested', 'facts.sqlite'),
    });

    await expect(blocked.check?.()).rejects.toThrow('is not writable');
  });

  it('reports a store that exists but can no longer be written', async () => {
    // The realistic failure: a volume that carries a store from an earlier run
    // and comes back read-only, or a pod that now runs as another user. Opening
    // such a database succeeds, so only an actual write proves anything.
    const store = sqliteFactStore<Place>({ path });
    await store.set(
      new Map([[MAASTRICHT, present({ name: 'Maastricht', latitude: 1 })]]),
      STAMP,
      VERSION,
    );
    await chmod(join(directory, 'store'), 0o555);
    await chmod(path, 0o444);

    const reopened = sqliteFactStore<Place>({ path });

    await expect(reopened.check?.()).rejects.toThrow('is not writable');
  });

  it('passes check() on a writable store, leaving nothing behind', async () => {
    const store = sqliteFactStore<Place>({ path });

    await expect(store.check?.()).resolves.toBeUndefined();

    // The probe is rolled back, so it is not visible to a reader afterwards.
    const reader = sqliteFactStore<Place>({ path });
    expect((await reader.get(['__lde_resolver_write_probe__'])).size).toBe(0);
  });

  it('rolls a write back rather than leaving half a batch behind', async () => {
    const store = sqliteFactStore<Place>({ path });
    await store.set(
      new Map([[MAASTRICHT, present({ name: 'Maastricht', latitude: 1 })]]),
      STAMP,
      VERSION,
    );

    // A BigInt cannot be serialized, so the second entry throws mid-batch.
    const unserializable = { name: 'Venlo', latitude: 1n } as unknown as Place;
    await expect(
      store.set(
        new Map([
          [VENLO, present(unserializable)],
          [MAASTRICHT, present({ name: 'replaced', latitude: 2 })],
        ]),
        '2026-09-01T00:00:00.000Z',
        VERSION,
      ),
    ).rejects.toThrow();

    // Neither the new key nor the rewrite of the old one survived.
    expect(await store.get([VENLO])).toEqual(new Map());
    expect(await store.get([MAASTRICHT])).toEqual(
      new Map([
        [
          MAASTRICHT,
          {
            status: 'present',
            fact: { name: 'Maastricht', latitude: 1 },
            fetchedAt: STAMP,
            version: VERSION,
          },
        ],
      ]),
    );
  });

  it('reads and purges more keys than one statement may carry', async () => {
    // Keys become bound parameters, and a statement holds a bounded number of
    // them; a caller passing a large batch must not meet a SQL error.
    const store = sqliteFactStore<Place>({ path });
    const many = Array.from(
      { length: 1_200 },
      (_unused, index) => `https://sws.geonames.org/${index}/`,
    );
    await store.set(
      new Map(many.map((key) => [key, present({ name: key, latitude: 1 })])),
      STAMP,
      VERSION,
    );

    expect((await store.get(many)).size).toBe(1_200);

    await store.purge(many);
    expect((await store.get(many)).size).toBe(0);
  });

  it('closes its handle, and opens another on the next use', async () => {
    // A process building one store per run would otherwise hold every database
    // it ever opened until it exited.
    const store = sqliteFactStore<Place>({ path });
    await store.set(
      new Map([[MAASTRICHT, present({ name: 'Maastricht', latitude: 1 })]]),
      STAMP,
      VERSION,
    );

    await store.close?.();

    // Closing releases the handle without losing what was written.
    expect((await store.get([MAASTRICHT])).size).toBe(1);
  });

  it('closes cleanly when nothing was ever opened', async () => {
    const store = sqliteFactStore<Place>({ path });

    await expect(store.close?.()).resolves.toBeUndefined();
  });

  it('serves a resolver across runs', async () => {
    let fetches = 0;
    const resolverOverStore = () =>
      createResolver<string, Place>({
        key: (iri) => iri,
        host: urlHost,
        fetch: async (iris) => {
          fetches++;
          return iris.map((iri) => [
            iri,
            { name: 'Maastricht', latitude: 50.85 },
          ]);
        },
        store: sqliteFactStore<Place>({ path }),
      });

    await resolverOverStore().resolveAll([MAASTRICHT]);
    // A second resolver over the same file is the next run of the same pipeline.
    const second = await resolverOverStore().resolveAll([MAASTRICHT]);

    expect(fetches).toBe(1);
    expect(second.get(MAASTRICHT)).toMatchObject({
      outcome: 'resolved',
      fromStore: true,
    });
  });

  it('remembers an absence across runs, so the source is asked once', async () => {
    let fetches = 0;
    const resolverOverStore = () =>
      createResolver<string, Place>({
        key: (iri) => iri,
        host: urlHost,
        fetch: async () => {
          fetches++;
          return [];
        },
        store: sqliteFactStore<Place>({ path }),
      });

    await resolverOverStore().resolveAll([VENLO]);
    const second = await resolverOverStore().resolveAll([VENLO]);

    expect(fetches).toBe(1);
    expect(second.get(VENLO)).toMatchObject({ outcome: 'absent' });
  });
});
