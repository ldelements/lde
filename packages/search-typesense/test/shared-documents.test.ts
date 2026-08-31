import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Client } from 'typesense';
import type { SearchType } from '@lde/search';
import { Dataset } from '@lde/dataset';
import { BlueGreenRebuild } from '../src/blue-green-rebuild.js';
import { InPlaceRebuild } from '../src/in-place-rebuild.js';
import { TypesenseContainer } from './typesense-container.js';
import { makeRunContext, stream } from './helpers.js';

/**
 * A canonically keyed collection, where two datasets referencing the same
 * GeoNames place produce ONE document. Membership is then a set – which
 * datasets reference this document – and every sweep retracts one dataset
 * rather than deleting what another still points at.
 *
 * The scenarios are the ones that were broken while a document carried a
 * single `source` stamp: a departing dataset took another's documents with it,
 * and a dataset's stale sweep deleted what a dataset skipped as unchanged
 * still referenced – leaving that dataset's references dangling, with nothing
 * to rewrite them.
 */
const NAME = 'places';

const placeType: SearchType = {
  name: 'Place',
  class: 'https://example.org/Place',
  key: { field: 'sameAs' },
  fields: [
    { name: 'title', kind: 'keyword', output: true },
    { name: 'sameAs', kind: 'reference', path: 'owl:sameAs', array: true },
  ],
};

const datasetA = new Dataset({
  iri: new URL('http://example.org/dataset/a'),
  distributions: [],
});
const datasetB = new Dataset({
  iri: new URL('http://example.org/dataset/b'),
  distributions: [],
});

/** Maastricht: keyed on the GeoNames IRI, so both datasets write this id. */
const MAASTRICHT = 'https://sws.geonames.org/2751283/';

interface Referrer {
  readonly dataset: string;
  readonly run: number;
}

describe('a document several datasets reference', () => {
  const container = new TypesenseContainer();
  let client: Client;

  beforeAll(async () => {
    client = await container.start();
  }, 120_000);

  afterAll(async () => {
    await container.stop();
  });

  beforeEach(async () => {
    for (const collection of await client.collections().retrieve()) {
      await client.collections(collection.name).delete();
    }
  });

  async function documentIds(collection = NAME): Promise<string[]> {
    const response = await client
      .collections(collection)
      .documents()
      .search({ q: '*', query_by: 'title', per_page: 250 });
    return (response.hits ?? [])
      .map((hit) => (hit.document as { id: string }).id)
      .sort();
  }

  /** The datasets currently referencing a document. */
  async function referrers(id: string, collection = NAME): Promise<string[]> {
    const stored = (await client
      .collections(collection)
      .documents(id)
      .retrieve()) as { referenced_by?: Referrer[] };
    return (stored.referenced_by ?? [])
      .map((referrer) => referrer.dataset)
      .sort();
  }

  describe('InPlaceRebuild', () => {
    const writer = () =>
      new InPlaceRebuild<{ id: string; title: string }>(client, placeType, {
        collectionNameFor: () => NAME,
      });

    /** One committed run in which both datasets reference Maastricht. */
    async function seed(): Promise<void> {
      const run = await writer().openRun(
        makeRunContext([datasetA.iri.toString(), datasetB.iri.toString()]),
      );
      await run.write(
        datasetA,
        stream([
          { id: MAASTRICHT, title: 'Maastricht' },
          { id: 'http://a/only', title: 'A only' },
        ]),
      );
      await run.flush?.(datasetA, 'success');
      await run.write(
        datasetB,
        stream([
          { id: MAASTRICHT, title: 'Maastricht' },
          { id: 'http://b/only', title: 'B only' },
        ]),
      );
      await run.flush?.(datasetB, 'success');
      await run.commit();
    }

    it('records every dataset that references it, not whichever wrote last', async () => {
      await seed();

      expect(await referrers(MAASTRICHT)).toEqual([
        datasetA.iri.toString(),
        datasetB.iri.toString(),
      ]);
    });

    it('keeps the document when one dataset leaves the selection', async () => {
      await seed();

      // A is no longer selected; B is, and is skipped as unchanged.
      const run = await writer().openRun(
        makeRunContext([datasetB.iri.toString()]),
      );
      await run.commit();

      expect(await documentIds()).toEqual(['http://b/only', MAASTRICHT]);
      expect(await referrers(MAASTRICHT)).toEqual([datasetB.iri.toString()]);
    });

    it('keeps the document when a dataset stops referencing it, while another is skipped', async () => {
      await seed();

      // A runs and no longer contains Maastricht; B is selected but skipped as
      // unchanged, so nothing rewrites the document on its behalf.
      const run = await writer().openRun(
        makeRunContext([datasetA.iri.toString(), datasetB.iri.toString()]),
      );
      await run.write(
        datasetA,
        stream([{ id: 'http://a/only', title: 'A only' }]),
      );
      await run.flush?.(datasetA, 'success');
      await run.commit();

      expect(await documentIds()).toEqual([
        'http://a/only',
        'http://b/only',
        MAASTRICHT,
      ]);
      expect(await referrers(MAASTRICHT)).toEqual([datasetB.iri.toString()]);
    });

    it('deletes the document once the last dataset stops referencing it', async () => {
      await seed();

      const run = await writer().openRun(
        makeRunContext([datasetA.iri.toString(), datasetB.iri.toString()]),
      );
      await run.write(
        datasetA,
        stream([{ id: 'http://a/only', title: 'A only' }]),
      );
      await run.flush?.(datasetA, 'success');
      await run.write(
        datasetB,
        stream([{ id: 'http://b/only', title: 'B only' }]),
      );
      await run.flush?.(datasetB, 'success');
      await run.commit();

      expect(await documentIds()).toEqual(['http://a/only', 'http://b/only']);
    });

    it('deletes the document when every referring dataset leaves at once', async () => {
      await seed();

      const run = await writer().openRun(makeRunContext([]));
      await run.commit();

      expect(await documentIds()).toEqual([]);
    });

    it('records one dataset once when two of its nodes key onto one document', async () => {
      // Two nodes sharing a key are one document, so a dataset can reach the
      // same id twice within a batch – its membership is still one entry.
      const run = await writer().openRun(
        makeRunContext([datasetA.iri.toString()]),
      );
      await run.write(
        datasetA,
        stream([
          { id: MAASTRICHT, title: 'Maastricht' },
          { id: MAASTRICHT, title: 'Maestricht' },
        ]),
      );
      await run.flush?.(datasetA, 'success');
      await run.commit();

      expect(await referrers(MAASTRICHT)).toEqual([datasetA.iri.toString()]);
    });

    it('keeps membership right when a batch lands mid-stream', async () => {
      // The membership already stored has to be read per batch, not per
      // dataset: a batch that fills halfway through a dataset writes documents
      // the next batch must not overwrite blind.
      const batched = new InPlaceRebuild<{ id: string; title: string }>(
        client,
        placeType,
        { collectionNameFor: () => NAME, batchSize: 1 },
      );
      const run = await batched.openRun(
        makeRunContext([datasetA.iri.toString(), datasetB.iri.toString()]),
      );
      await run.write(
        datasetA,
        stream([
          { id: MAASTRICHT, title: 'Maastricht' },
          { id: 'http://a/only', title: 'A only' },
        ]),
      );
      await run.flush?.(datasetA, 'success');
      await run.write(
        datasetB,
        stream([{ id: MAASTRICHT, title: 'Maastricht' }]),
      );
      await run.flush?.(datasetB, 'success');
      await run.commit();

      expect(await referrers(MAASTRICHT)).toEqual([
        datasetA.iri.toString(),
        datasetB.iri.toString(),
      ]);
    });

    it('deletes more emptied documents than fit one filter', async () => {
      // Ids travel in a URL query string, so the deletes are budgeted into
      // several filters rather than one unbounded string.
      const many = Array.from({ length: 120 }, (unused, index) => ({
        id: `https://sws.geonames.org/275${index.toString().padStart(4, '0')}/`,
        title: `Place ${index}`,
      }));
      const seeding = await writer().openRun(
        makeRunContext([datasetA.iri.toString()]),
      );
      await seeding.write(datasetA, stream(many));
      await seeding.flush?.(datasetA, 'success');
      await seeding.commit();

      const run = await writer().openRun(makeRunContext([]));
      await run.commit();

      expect(await documentIds()).toEqual([]);
    });

    it('leaves the other dataset’s membership alone when a reset discards this run', async () => {
      await seed();

      // A’s endpoint attempt is discarded before the dump re-run.
      const run = await writer().openRun(
        makeRunContext([datasetA.iri.toString(), datasetB.iri.toString()]),
      );
      await run.write(
        datasetA,
        stream([{ id: MAASTRICHT, title: 'Maastricht' }]),
      );
      await run.reset?.(datasetA);

      // The document stays – B references it – having lost only A’s entry,
      // which the re-run re-adds.
      expect(await referrers(MAASTRICHT)).toEqual([datasetB.iri.toString()]);
      await run.write(
        datasetA,
        stream([{ id: MAASTRICHT, title: 'Maastricht' }]),
      );
      await run.flush?.(datasetA, 'success');
      await run.commit();
      expect(await referrers(MAASTRICHT)).toEqual([
        datasetA.iri.toString(),
        datasetB.iri.toString(),
      ]);
    });
  });

  describe('BlueGreenRebuild', () => {
    it('keeps a shared document when one dataset fails and is rolled back', async () => {
      const writer = new BlueGreenRebuild<{ id: string; title: string }>(
        client,
        placeType,
        { collectionNameFor: () => NAME },
      );
      const run = await writer.openRun(
        makeRunContext([datasetA.iri.toString(), datasetB.iri.toString()]),
      );
      await run.write(
        datasetA,
        stream([
          { id: MAASTRICHT, title: 'Maastricht' },
          { id: 'http://a/only', title: 'A only' },
        ]),
      );
      await run.flush?.(datasetA, 'success');
      await run.write(
        datasetB,
        stream([
          { id: MAASTRICHT, title: 'Maastricht' },
          { id: 'http://b/only', title: 'B only' },
        ]),
      );
      // B fails: its documents must not ship – but Maastricht is A’s too, and
      // A’s references to it have to keep resolving.
      await run.flush?.(datasetB, 'failed');
      await run.commit();

      expect(await documentIds()).toEqual(['http://a/only', MAASTRICHT]);
      expect(await referrers(MAASTRICHT)).toEqual([datasetA.iri.toString()]);
    });
  });
});
