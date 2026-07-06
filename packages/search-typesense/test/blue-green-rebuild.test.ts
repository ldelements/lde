import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Client } from 'typesense';
import type { SearchType } from '@lde/search';
import type { RunContext } from '@lde/pipeline';
import { Dataset } from '@lde/dataset';
import { BlueGreenRebuild } from '../src/blue-green-rebuild.js';
import { RebuildAlreadyRunning } from '../src/lock.js';
import { TypesenseContainer } from './typesense-container.js';

const NAME = 'datasets';
const LOCK_COLLECTION = 'rebuild_locks';

const datasetType: SearchType = {
  name: 'Dataset',
  type: 'https://example.org/Dataset',
  fields: [
    { name: 'title', kind: 'keyword' },
    { name: 'year', kind: 'integer' },
  ],
};

const dataset = new Dataset({
  iri: new URL('http://example.org/dataset/1'),
  distributions: [],
});

let runSequence = 0;

/** A fresh run context per call; startedAt strictly increases across runs. */
function makeRunContext(): RunContext {
  runSequence += 1;
  return {
    runId: `run-${runSequence}`,
    startedAt: new Date(
      Date.parse('2026-07-06T12:00:00.000Z') + runSequence * 1000,
    ).toISOString(),
    selectedSources: () => [dataset.iri.toString()],
  };
}

async function* stream<Document>(
  documents: readonly Document[],
): AsyncIterable<Document> {
  for (const document of documents) {
    yield document;
  }
}

async function aliasTarget(client: Client): Promise<string | undefined> {
  try {
    return (await client.aliases(NAME).retrieve()).collection_name;
  } catch {
    return undefined;
  }
}

async function seedLock(client: Client, acquiredAt: number): Promise<void> {
  await client.collections().create({
    name: LOCK_COLLECTION,
    fields: [{ name: 'acquired_at', type: 'int64' }],
  });
  await client
    .collections(LOCK_COLLECTION)
    .documents()
    .create({ id: NAME, acquired_at: acquiredAt });
}

async function reset(client: Client): Promise<void> {
  const { aliases } = await client.aliases().retrieve();
  for (const alias of aliases) {
    await client.aliases(alias.name).delete();
  }
  for (const collection of await client.collections().retrieve()) {
    await client.collections(collection.name).delete();
  }
}

describe('BlueGreenRebuild', () => {
  const container = new TypesenseContainer();
  let client: Client;

  beforeAll(async () => {
    client = await container.start();
  }, 120_000);

  afterAll(async () => {
    await container.stop();
  });

  beforeEach(async () => {
    await reset(client);
  });

  it('publishes a versioned collection and points the index alias at it on commit', async () => {
    const writer = new BlueGreenRebuild(client, datasetType, { name: NAME });

    const run = await writer.openRun(makeRunContext());
    await run.write(
      dataset,
      stream([{ id: 'a', title: 'Verhaal van Utrecht', year: 2024 }]),
    );
    await run.commit();

    const live = await aliasTarget(client);
    expect(live).toMatch(/^datasets_\d+$/);
    // The alias resolves for queries just like a collection name.
    const stored = await client.collections(NAME).documents('a').retrieve();
    expect((stored as Record<string, unknown>).title).toBe(
      'Verhaal van Utrecht',
    );
  });

  it('keeps the live collection unswapped until commit', async () => {
    const writer = new BlueGreenRebuild(client, datasetType, { name: NAME });

    const run = await writer.openRun(makeRunContext());
    await run.write(dataset, stream([{ id: 'a', title: 'A', year: 2024 }]));

    expect(await aliasTarget(client)).toBeUndefined();

    await run.commit();
    expect(await aliasTarget(client)).toBeDefined();
  });

  it('swaps the alias to the new collection and drops the previous one', async () => {
    const writer = new BlueGreenRebuild(client, datasetType, { name: NAME });

    const first = await writer.openRun(makeRunContext());
    await first.write(dataset, stream([{ id: 'a', title: 'Old', year: 2023 }]));
    await first.commit();
    const previous = await aliasTarget(client);

    const second = await writer.openRun(makeRunContext());
    await second.write(
      dataset,
      stream([{ id: 'a', title: 'New', year: 2024 }]),
    );
    await second.commit();

    const live = await aliasTarget(client);
    expect(live).not.toBe(previous);
    expect(await client.collections(previous ?? '').exists()).toBe(false);
    const stored = await client.collections(NAME).documents('a').retrieve();
    expect((stored as Record<string, unknown>).title).toBe('New');
  });

  it('batches documents within and across write calls', async () => {
    const writer = new BlueGreenRebuild(client, datasetType, {
      name: NAME,
      batchSize: 2,
    });

    const run = await writer.openRun(makeRunContext());
    for (let index = 0; index < 5; index++) {
      await run.write(
        dataset,
        stream([{ id: `d${index}`, title: `Title ${index}`, year: 2024 }]),
      );
    }
    await run.commit();

    expect((await client.collections(NAME).retrieve()).num_documents).toBe(5);
  });

  it('refuses to open a run while another rebuild holds the index lock', async () => {
    await seedLock(client, Date.now());
    const writer = new BlueGreenRebuild(client, datasetType, { name: NAME });

    await expect(writer.openRun(makeRunContext())).rejects.toThrow(
      RebuildAlreadyRunning,
    );
    expect(await aliasTarget(client)).toBeUndefined();
  });

  it('reclaims a stale lock and rebuilds', async () => {
    await seedLock(client, Date.now() - 10_000);
    const writer = new BlueGreenRebuild(client, datasetType, {
      name: NAME,
      lockTtlMs: 1_000,
    });

    const run = await writer.openRun(makeRunContext());
    await run.write(dataset, stream([{ id: 'a', title: 'A', year: 2024 }]));
    await run.commit();

    expect(await aliasTarget(client)).toBeDefined();
  });

  it('abort drops the half-built collection and leaves the live alias intact', async () => {
    const writer = new BlueGreenRebuild(client, datasetType, { name: NAME });

    const first = await writer.openRun(makeRunContext());
    await first.write(
      dataset,
      stream([{ id: 'a', title: 'Live', year: 2024 }]),
    );
    await first.commit();
    const live = await aliasTarget(client);
    const collectionCount = (await client.collections().retrieve()).length;

    const second = await writer.openRun(makeRunContext());
    await second.write(dataset, stream([{ id: 'b', title: 'B', year: 2025 }]));
    await second.abort(new Error('run failed elsewhere'));

    // Nothing swapped, no orphaned half-built collection left behind.
    expect(await aliasTarget(client)).toBe(live);
    expect((await client.collections().retrieve()).length).toBe(
      collectionCount,
    );

    // The lock was released: a subsequent run proceeds.
    const third = await writer.openRun(makeRunContext());
    await third.write(dataset, stream([{ id: 'c', title: 'C', year: 2026 }]));
    await third.commit();
    expect(await aliasTarget(client)).not.toBe(live);
  });

  it('surfaces per-document import failures from write', async () => {
    const writer = new BlueGreenRebuild(client, datasetType, { name: NAME });

    const run = await writer.openRun(makeRunContext());
    // `year` must be an int; a string is a hard validation failure.
    await expect(
      (async () => {
        await run.write(
          dataset,
          stream([{ id: 'bad', title: 't', year: 'nope' }]),
        );
        await run.commit();
      })(),
    ).rejects.toThrow(/failed/i);
    await run.abort(new Error('import failed'));

    expect(await aliasTarget(client)).toBeUndefined();
  });

  it('publishes an empty collection for an empty run', async () => {
    const writer = new BlueGreenRebuild(client, datasetType, { name: NAME });

    const run = await writer.openRun(makeRunContext());
    await run.commit();

    expect((await client.collections(NAME).retrieve()).num_documents).toBe(0);
  });
});
