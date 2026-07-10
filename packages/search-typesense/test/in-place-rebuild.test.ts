import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Client } from 'typesense';
import type { SearchType } from '@lde/search';
import { Dataset } from '@lde/dataset';
import { InPlaceRebuild } from '../src/in-place-rebuild.js';
import { RebuildAlreadyRunning } from '../src/lock.js';
import { TypesenseContainer } from './typesense-container.js';
import { currentRunId, makeRunContext, seedLock, stream } from './helpers.js';

const NAME = 'objects';

const objectType: SearchType = {
  name: 'Object',
  class: 'https://example.org/Object',
  fields: [{ name: 'title', kind: 'keyword' }],
};

const datasetA = new Dataset({
  iri: new URL('http://example.org/dataset/a'),
  distributions: [],
});
const datasetB = new Dataset({
  iri: new URL('http://example.org/dataset/b'),
  distributions: [],
});

async function documentIds(client: Client): Promise<string[]> {
  const response = await client
    .collections(NAME)
    .documents()
    .search({ q: '*', query_by: 'title', per_page: 250 });
  return (response.hits ?? [])
    .map((hit) => (hit.document as { id: string }).id)
    .sort();
}

async function reset(client: Client): Promise<void> {
  for (const collection of await client.collections().retrieve()) {
    await client.collections(collection.name).delete();
  }
}

/** Seed the index: one committed run writing the given docs per dataset. */
async function seed(
  writer: InPlaceRebuild<{ id: string; title: string }>,
  documentsPerDataset: Map<Dataset, { id: string; title: string }[]>,
): Promise<void> {
  const run = await writer.openRun(
    makeRunContext(
      [...documentsPerDataset.keys()].map((dataset) => dataset.iri.toString()),
    ),
  );
  for (const [dataset, documents] of documentsPerDataset) {
    await run.write(dataset, stream(documents));
    await run.flush?.(dataset, 'success');
  }
  await run.commit();
}

describe('InPlaceRebuild', () => {
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

  it('upserts documents stamped with their source, visible without a commit barrier', async () => {
    const writer = new InPlaceRebuild<{ id: string; title: string }>(
      client,
      objectType,
      { name: NAME },
    );

    const run = await writer.openRun(makeRunContext([datasetA.iri.toString()]));
    await run.write(datasetA, stream([{ id: 'a1', title: 'One' }]));
    await run.flush?.(datasetA, 'success');

    // In-place has no staging: after a dataset flush the docs are live.
    const stored = (await client
      .collections(NAME)
      .documents('a1')
      .retrieve()) as Record<string, unknown>;
    expect(stored.title).toBe('One');
    expect(stored.source).toBe('http://example.org/dataset/a');
    expect(stored.last_seen).toBe(currentRunId());

    await run.commit();
  });

  it('sweeps a source’s stale documents when the dataset flushes successfully', async () => {
    const writer = new InPlaceRebuild<{ id: string; title: string }>(
      client,
      objectType,
      { name: NAME },
    );
    await seed(
      writer,
      new Map([
        [
          datasetA,
          [
            { id: 'a1', title: 'One' },
            { id: 'a2', title: 'Two' },
          ],
        ],
        [datasetB, [{ id: 'b1', title: 'Bee' }]],
      ]),
    );

    // Next run: dataset A no longer contains a2.
    const run = await writer.openRun(
      makeRunContext([datasetA.iri.toString(), datasetB.iri.toString()]),
    );
    await run.write(datasetA, stream([{ id: 'a1', title: 'One updated' }]));
    await run.flush?.(datasetA, 'success');
    await run.commit();

    // a2 left with its source; the other source’s documents are untouched.
    expect(await documentIds(client)).toEqual(['a1', 'b1']);
    const updated = (await client
      .collections(NAME)
      .documents('a1')
      .retrieve()) as Record<string, unknown>;
    expect(updated.title).toBe('One updated');
  });

  it('does not sweep a dataset that failed: its unwritten documents survive', async () => {
    const writer = new InPlaceRebuild<{ id: string; title: string }>(
      client,
      objectType,
      { name: NAME },
    );
    await seed(
      writer,
      new Map([
        [
          datasetA,
          [
            { id: 'a1', title: 'One' },
            { id: 'a2', title: 'Two' },
          ],
        ],
      ]),
    );

    // Next run wrote only part of A before its stages hard-failed.
    const run = await writer.openRun(makeRunContext([datasetA.iri.toString()]));
    await run.write(datasetA, stream([{ id: 'a1', title: 'One updated' }]));
    await run.flush?.(datasetA, 'failed');
    await run.commit();

    // a2 was not rewritten by the failed run – and not deleted either; the
    // next successful run reconciles.
    expect(await documentIds(client)).toEqual(['a1', 'a2']);
  });

  it('sweeps every document of a source that left the selection on commit', async () => {
    const writer = new InPlaceRebuild<{ id: string; title: string }>(
      client,
      objectType,
      { name: NAME },
    );
    await seed(
      writer,
      new Map([
        [datasetA, [{ id: 'a1', title: 'One' }]],
        [datasetB, [{ id: 'b1', title: 'Bee' }]],
      ]),
    );

    // Dataset B is no longer registered: it is not in the run’s selection.
    const run = await writer.openRun(makeRunContext([datasetA.iri.toString()]));
    await run.write(datasetA, stream([{ id: 'a1', title: 'One' }]));
    await run.flush?.(datasetA, 'success');
    await run.commit();

    expect(await documentIds(client)).toEqual(['a1']);
  });

  it('keeps a selected-but-skipped dataset’s documents through both sweeps', async () => {
    const writer = new InPlaceRebuild<{ id: string; title: string }>(
      client,
      objectType,
      { name: NAME },
    );
    await seed(
      writer,
      new Map([
        [datasetA, [{ id: 'a1', title: 'One' }]],
        [datasetB, [{ id: 'b1', title: 'Bee' }]],
      ]),
    );

    // Dataset B is still selected but skipped as unchanged: never written,
    // never flushed. Its documents must survive the run untouched.
    const run = await writer.openRun(
      makeRunContext([datasetA.iri.toString(), datasetB.iri.toString()]),
    );
    await run.write(datasetA, stream([{ id: 'a1', title: 'One' }]));
    await run.flush?.(datasetA, 'success');
    await run.commit();

    expect(await documentIds(client)).toEqual(['a1', 'b1']);
  });

  it('refuses to open a run while another rebuild holds the index lock', async () => {
    await seedLock(client, NAME, Date.now());
    const writer = new InPlaceRebuild<{ id: string; title: string }>(
      client,
      objectType,
      { name: NAME },
    );

    await expect(
      writer.openRun(makeRunContext([datasetA.iri.toString()])),
    ).rejects.toThrow(RebuildAlreadyRunning);
  });

  it('abort releases the lock and leaves the live index for next-run reconciliation', async () => {
    // batchSize 1 so the aborted run's partial write lands before the abort,
    // like a run dying midway through a dataset.
    const writer = new InPlaceRebuild<{ id: string; title: string }>(
      client,
      objectType,
      { name: NAME, batchSize: 1 },
    );
    await seed(writer, new Map([[datasetA, [{ id: 'a1', title: 'One' }]]]));

    const aborted = await writer.openRun(
      makeRunContext([datasetA.iri.toString()]),
    );
    await aborted.write(
      datasetA,
      stream([{ id: 'a2', title: 'Partial write' }]),
    );
    await aborted.abort(new Error('run failed elsewhere'));

    // Whatever landed stays (upserts are idempotent); nothing is rolled back.
    expect(await documentIds(client)).toEqual(['a1', 'a2']);

    // The lock was released: the next run opens and reconciles – its
    // successful flush sweeps the leftover a2.
    const next = await writer.openRun(
      makeRunContext([datasetA.iri.toString()]),
    );
    await next.write(datasetA, stream([{ id: 'a1', title: 'One' }]));
    await next.flush?.(datasetA, 'success');
    await next.commit();
    expect(await documentIds(client)).toEqual(['a1']);
  });

  it('reset discards only this run’s writes for a source, keeping prior-run documents', async () => {
    const writer = new InPlaceRebuild<{ id: string; title: string }>(
      client,
      objectType,
      { name: NAME, batchSize: 1 },
    );
    await seed(
      writer,
      new Map([
        [
          datasetA,
          [
            { id: 'a1', title: 'One' },
            { id: 'a2', title: 'Two' },
          ],
        ],
        [datasetB, [{ id: 'b1', title: 'Bee' }]],
      ]),
    );

    // Next run: a partial endpoint attempt adds a3 to A, then the stage fails.
    const run = await writer.openRun(
      makeRunContext([datasetA.iri.toString(), datasetB.iri.toString()]),
    );
    await run.write(
      datasetA,
      stream([{ id: 'a3', title: 'Endpoint straggler' }]),
    );
    await run.reset?.(datasetA);

    // reset removed only this run’s a3; A’s prior-run docs and B are untouched.
    expect(await documentIds(client)).toEqual(['a1', 'a2', 'b1']);

    // The dump re-run rebuilds A; the success sweep drops nothing extra.
    await run.write(
      datasetA,
      stream([
        { id: 'a1', title: 'One' },
        { id: 'a2', title: 'Two' },
      ]),
    );
    await run.flush?.(datasetA, 'success');
    await run.commit();

    expect(await documentIds(client)).toEqual(['a1', 'a2', 'b1']);
  });

  it('rejects a SearchType that declares the reserved bookkeeping fields', () => {
    const clashing: SearchType = {
      name: 'Object',
      class: 'https://example.org/Object',
      fields: [{ name: 'source', kind: 'keyword' }],
    };

    expect(() => new InPlaceRebuild(client, clashing, { name: NAME })).toThrow(
      /source/,
    );
  });
});
