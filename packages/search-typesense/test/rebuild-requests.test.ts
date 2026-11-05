import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Client } from 'typesense';
import { requestRebuild, type SearchType } from '@lde/search';
import { Dataset } from '@lde/dataset';
import { BlueGreenRebuild } from '../src/blue-green-rebuild.js';
import { TypesenseRebuildRequests } from '../src/rebuild-requests.js';
import { TypesenseContainer } from './typesense-container.js';
import { makeRunContext, seedLock, stream, typesenseError } from './helpers.js';

const NAME = 'datasets';

const datasetType: SearchType = {
  name: 'Dataset',
  class: 'https://example.org/Dataset',
  fields: [{ name: 'title', kind: 'keyword', output: true }],
};

const dataset = new Dataset({
  iri: new URL('http://example.org/dataset/1'),
  distributions: [],
});

describe('TypesenseRebuildRequests', () => {
  const container = new TypesenseContainer();
  let client: Client;

  beforeAll(async () => {
    client = await container.start();
  }, 120_000);

  afterAll(async () => {
    await container.stop();
  });

  beforeEach(async () => {
    const { aliases } = await client.aliases().retrieve();
    for (const alias of aliases) {
      await client.aliases(alias.name).delete();
    }
    for (const collection of await client.collections().retrieve()) {
      await client.collections(collection.name).delete();
    }
  });

  it('has no latest request before the first is recorded', async () => {
    expect(
      await new TypesenseRebuildRequests(client, NAME).latest(),
    ).toBeUndefined();
  });

  it('replaces the latest request with each one recorded', async () => {
    const requests = new TypesenseRebuildRequests(client, NAME);

    await requests.record();
    const first = await requests.latest();
    await requests.record();
    const second = await requests.latest();

    expect(first).toBeDefined();
    expect(second).toBeDefined();
    expect(second).not.toBe(first);
  });

  it('keeps each index’s requests apart', async () => {
    await new TypesenseRebuildRequests(client, NAME).record();

    expect(
      await new TypesenseRebuildRequests(client, 'labels').latest(),
    ).toBeUndefined();
  });

  it('leaves a request for the run holding the lock instead of rebuilding', async () => {
    const writer = new BlueGreenRebuild<{ id: string; title: string }>(
      client,
      datasetType,
      { collectionNameFor: () => NAME },
    );
    const rebuild = async () => {
      const run = await writer.openRun(makeRunContext());
      await run.write(dataset, stream([{ id: 'a', title: 'A' }]));
      await run.commit();
    };
    const requests = new TypesenseRebuildRequests(client, NAME);
    await seedLock(client, NAME, Date.now());

    await requestRebuild(rebuild, requests);

    // Nothing went live, and the request waits for the holder.
    await expect(client.aliases(NAME).retrieve()).rejects.toThrow();
    expect(await requests.latest()).toBeDefined();
  });
});

describe('TypesenseRebuildRequests errors', () => {
  /** A client whose request documents fail with `error`. */
  function failingClient(error: Error): Client {
    const fail = () => Promise.reject(error);
    return {
      collections: () => ({
        documents: () => ({ upsert: fail, retrieve: fail }),
      }),
    } as unknown as Client;
  }

  it('rethrows an unexpected error from recording a request', async () => {
    await expect(
      new TypesenseRebuildRequests(
        failingClient(typesenseError(503)),
        NAME,
      ).record(),
    ).rejects.toThrow('HTTP 503');
  });

  it('rethrows an unexpected error from reading the latest request', async () => {
    await expect(
      new TypesenseRebuildRequests(
        failingClient(typesenseError(503)),
        NAME,
      ).latest(),
    ).rejects.toThrow('HTTP 503');
  });
});
