import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { DataFactory } from 'n3';
import type { Quad } from '@rdfjs/types';
import type { Client } from 'typesense';
import { Dataset } from '@lde/dataset';
import type { RunContext, Writer } from '@lde/pipeline';
import {
  searchSchema,
  type SearchDocument,
  type SearchType,
} from '@lde/search';
import { BlueGreenRebuild } from '@lde/search-typesense';
import { searchIndexWriter } from '../src/search-index-writer.js';
import { TypesenseContainer } from './typesense-container.js';

const { namedNode, literal, quad } = DataFactory;

const RDF_TYPE = 'http://www.w3.org/1999/02/22-rdf-syntax-ns#type';
const DATASET = 'https://example.org/Dataset';
const ORGANIZATION = 'https://example.org/Organization';
const TITLE = 'https://example.org/title';
const NAME = 'https://example.org/name';

// The Dataset Register in miniature: a `datasets` catalog collection plus one
// typed label collection (its Organization label source), built from one
// whole-schema projection.
const schema = searchSchema(
  {
    name: 'Dataset',
    type: DATASET,
    fields: [{ name: 'title', kind: 'keyword', path: TITLE, array: true }],
  },
  {
    name: 'Organization',
    type: ORGANIZATION,
    fields: [{ name: 'name', kind: 'keyword', path: NAME, array: true }],
  },
);

const COLLECTION: Record<string, string> = {
  [DATASET]: 'datasets',
  [ORGANIZATION]: 'organizations',
};

const dataset = new Dataset({
  iri: new URL('http://example.org/dataset/1'),
  distributions: [],
});

/** A mixed graph: one Dataset node and one Organization node. */
function mixedQuads(): Quad[] {
  return [
    quad(namedNode('https://ex/d/1'), namedNode(RDF_TYPE), namedNode(DATASET)),
    quad(namedNode('https://ex/d/1'), namedNode(TITLE), literal('Verhaal')),
    quad(
      namedNode('https://ex/o/1'),
      namedNode(RDF_TYPE),
      namedNode(ORGANIZATION),
    ),
    quad(namedNode('https://ex/o/1'), namedNode(NAME), literal('Rijksmuseum')),
  ];
}

async function* stream<Item>(items: readonly Item[]): AsyncIterable<Item> {
  yield* items;
}

function makeRunContext(): RunContext {
  return {
    runId: 'run-1',
    startedAt: '2026-07-06T12:00:00.000Z',
    selectedSources: () => [dataset.iri.toString()],
  };
}

function blueGreenFor(
  client: Client,
): (searchType: SearchType) => Writer<SearchDocument> {
  return (searchType) =>
    new BlueGreenRebuild(client, searchType, {
      name: COLLECTION[searchType.type],
    });
}

async function aliasTarget(
  client: Client,
  name: string,
): Promise<string | undefined> {
  try {
    return (await client.aliases(name).retrieve()).collection_name;
  } catch {
    return undefined;
  }
}

async function liveIds(client: Client, name: string): Promise<string[]> {
  const field = name === 'datasets' ? 'title' : 'name';
  const response = await client
    .collections(name)
    .documents()
    .search({ q: '*', query_by: field, per_page: 250 });
  return (response.hits ?? [])
    .map((hit) => (hit.document as { id: string }).id)
    .sort();
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

describe('TypesenseContainer', () => {
  it('refuses to hand out a client before it is started', () => {
    expect(() => new TypesenseContainer().client()).toThrow(/not started/);
  });

  it('stop is a no-op before it is started', async () => {
    await expect(new TypesenseContainer().stop()).resolves.toBeUndefined();
  });
});

describe('searchIndexWriter over multiple Typesense collections', () => {
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

  it('swaps each type’s collection independently from one mixed stream', async () => {
    const run = await searchIndexWriter({
      schema,
      writerFor: blueGreenFor(client),
    }).openRun(makeRunContext());

    await run.write(dataset, stream(mixedQuads()));
    await run.flush?.(dataset, 'success');
    await run.commit();

    // Each collection went live on its own versioned collection + alias.
    expect(await aliasTarget(client, 'datasets')).toMatch(/^datasets_\d+$/);
    expect(await aliasTarget(client, 'organizations')).toMatch(
      /^organizations_\d+$/,
    );
    // Each carries only the documents projected for its type.
    expect(await liveIds(client, 'datasets')).toEqual(['https://ex/d/1']);
    expect(await liveIds(client, 'organizations')).toEqual(['https://ex/o/1']);
  });

  it('lets the datasets index go live even when a label collection fails to commit', async () => {
    // The Organization rebuild fails at commit, before its alias swaps. The
    // datasets index must still go live; the failure must surface.
    const failing: (searchType: SearchType) => Writer<SearchDocument> = (
      searchType,
    ) => {
      const real = blueGreenFor(client)(searchType);
      if (searchType.type !== ORGANIZATION) {
        return real;
      }
      return {
        openRun: async (context) => {
          const inner = await real.openRun(context);
          return {
            ...inner,
            commit: async () => {
              throw new Error('organization collection swap failed');
            },
          };
        },
      };
    };

    const run = await searchIndexWriter({ schema, writerFor: failing }).openRun(
      makeRunContext(),
    );
    await run.write(dataset, stream(mixedQuads()));
    await run.flush?.(dataset, 'success');

    const commit = run.commit();
    await expect(commit).rejects.toThrow(AggregateError);
    // The pipeline aborts the run after commit throws; the committed datasets
    // collection must survive that abort, the half-built organizations one must
    // be dropped.
    await run.abort(new Error('run failed'));

    expect(await aliasTarget(client, 'datasets')).toMatch(/^datasets_\d+$/);
    expect(await liveIds(client, 'datasets')).toEqual(['https://ex/d/1']);
    // Organizations never swapped, and its half-built collection was cleaned up.
    expect(await aliasTarget(client, 'organizations')).toBeUndefined();
    const collections = (await client.collections().retrieve()).map(
      (collection) => collection.name,
    );
    expect(collections.some((name) => name.startsWith('organizations_'))).toBe(
      false,
    );
  });

  it('commits an empty collection for a type absent from the projection, leaving the others intact', async () => {
    // Only Dataset quads: the Organization projection is empty this run.
    const datasetOnly = [
      quad(
        namedNode('https://ex/d/1'),
        namedNode(RDF_TYPE),
        namedNode(DATASET),
      ),
      quad(namedNode('https://ex/d/1'), namedNode(TITLE), literal('Verhaal')),
    ];

    const run = await searchIndexWriter({
      schema,
      writerFor: blueGreenFor(client),
    }).openRun(makeRunContext());
    await run.write(dataset, stream(datasetOnly));
    await run.flush?.(dataset, 'success');
    await run.commit();

    // Datasets went live with its document; organizations went live empty —
    // the empty projection wiped only its own collection, never datasets.
    expect(await liveIds(client, 'datasets')).toEqual(['https://ex/d/1']);
    expect(await aliasTarget(client, 'organizations')).toMatch(
      /^organizations_\d+$/,
    );
    expect(await liveIds(client, 'organizations')).toEqual([]);
  });

  it('abort drops every half-built collection and leaves no alias', async () => {
    const run = await searchIndexWriter({
      schema,
      writerFor: blueGreenFor(client),
    }).openRun(makeRunContext());
    await run.write(dataset, stream(mixedQuads()));
    await run.flush?.(dataset, 'success');

    await run.abort(new Error('run failed before commit'));

    expect(await aliasTarget(client, 'datasets')).toBeUndefined();
    expect(await aliasTarget(client, 'organizations')).toBeUndefined();
    // Only the lock collection may remain; no half-built versioned collections.
    const versioned = (await client.collections().retrieve())
      .map((collection) => collection.name)
      .filter((name) => /_\d+$/.test(name));
    expect(versioned).toEqual([]);
  });
});
