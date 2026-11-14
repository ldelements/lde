import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Client } from 'typesense';
import { Dataset, Distribution } from '@lde/dataset';
import {
  ProbedDistributions,
  ResolvedDistribution,
  type DistributionResolver,
  type Reporter,
} from '@lde/pipeline';
import { defineSearchType, searchSchema, type RootType } from '@lde/search';
import {
  createTypesenseSearchEngine,
  InPlaceRebuild,
} from '@lde/search-typesense';
import {
  startSparqlEndpoint,
  teardownSparqlEndpoint,
} from '@lde/local-sparql-endpoint';
import { searchIndexerPipeline } from '../src/search-indexer-pipeline.js';
import { TypesenseContainer } from './typesense-container.js';

const SCHEMA = 'https://schema.org/';
const DCTERMS = 'http://purl.org/dc/terms/';

/** The `label` every label source must serve, so a reference can resolve one
 *  – and so a joinable reference has a target at all. */
const label = (path: string) =>
  ({
    name: 'label',
    kind: 'text',
    path: `<${path}>`,
    locales: ['nl'],
    output: true,
    searchable: { weight: 5 },
  }) as const;

const publisher = defineSearchType({
  name: 'Publisher',
  class: `${SCHEMA}Organization`,
  fields: [label(`${SCHEMA}name`)],
});

const dataset = defineSearchType({
  name: 'Dataset',
  class: 'http://www.w3.org/ns/dcat#Dataset',
  fields: [
    label(`${DCTERMS}title`),
    {
      name: 'publisher',
      kind: 'reference',
      path: `<${DCTERMS}publisher>`,
      filterable: true,
      output: true,
      joinable: true,
      ref: { strategy: 'lookup', target: 'Publisher' },
    },
  ],
});

const creativeWork = defineSearchType({
  name: 'CreativeWork',
  class: `${SCHEMA}CreativeWork`,
  fields: [
    label(`${SCHEMA}name`),
    {
      name: 'dataset',
      kind: 'reference',
      path: `<${DCTERMS}isPartOf>`,
      filterable: true,
      output: true,
      joinable: true,
      ref: { strategy: 'lookup', target: 'Dataset' },
    },
  ],
});

// Declared referrer-first ON PURPOSE. The stage order follows the declaration,
// so `creative_works` documents are imported before the `datasets` they
// reference and before the `publishers` behind those – the out-of-order arrival
// `async_reference` has to back-fill, and the assumption most likely to regress
// on a Typesense upgrade.
const schema = searchSchema(creativeWork, dataset, publisher);

// Sized against the import batch so that a run both back-fills and overlaps.
// Datasets and works fill a batch while their stages run, and those datasets
// point at publishers that do not exist yet, since fewer publishers than a
// batch holds stay buffered until the dataset is flushed. The flush then lands
// all three collections’ remainders at once: the overlap in which Typesense
// 30.2 loses a reference for good, and which the writer’s join-component
// import lock excludes (ADR 39).
const BULK_PUBLISHERS = 50;
const BULK_DATASETS = 900;
const BULK_WORKS = 900;
const BATCH_SIZE = 600;

/** Bulk data in the fixture’s shape: every work in a dataset, every dataset
 *  with a publisher. */
function bulkTurtle(): string {
  const lines: string[] = [];
  for (let index = 0; index < BULK_PUBLISHERS; index++) {
    lines.push(
      `<https://ex/pub/bulk/${index}> a schema:Organization ; schema:name "Uitgever ${index}"@nl .`,
    );
  }
  for (let index = 0; index < BULK_DATASETS; index++) {
    lines.push(
      `<https://ex/ds/bulk/${index}> a dcat:Dataset ; dcterms:title "Dataset ${index}"@nl ; dcterms:publisher <https://ex/pub/bulk/${index % BULK_PUBLISHERS}> .`,
    );
  }
  for (let index = 0; index < BULK_WORKS; index++) {
    lines.push(
      `<https://ex/cw/bulk/${index}> a schema:CreativeWork ; schema:name "Werk ${index}"@nl ; dcterms:isPartOf <https://ex/ds/bulk/${index % BULK_DATASETS}> .`,
    );
  }
  return lines.join('\n');
}

/** Each referenced collection, and the collection and field that point at
 *  it. */
const REFERRERS: Readonly<
  Record<string, { readonly collection: string; readonly field: string }>
> = {
  datasets: { collection: 'creative_works', field: 'dataset' },
  publishers: { collection: 'datasets', field: 'publisher' },
};

/**
 * `client`, except that each batch import calls `afterImport` once Typesense
 * has answered it – still inside the writer’s import, so before the writer
 * lets an import into another collection of the component start.
 */
function observingImports(
  client: Client,
  afterImport: (
    collection: string,
    documents: readonly { readonly id: string }[],
  ) => Promise<void>,
): Client {
  const documentsOf = (collection: string, documents: object) =>
    new Proxy(documents, {
      get: (target, property) =>
        property === 'import'
          ? async (batch: { id: string }[], options: unknown) => {
              const result = await (
                target as { import: (...args: unknown[]) => Promise<unknown> }
              ).import(batch, options);
              await afterImport(collection, batch);
              return result;
            }
          : Reflect.get(target, property, target),
    });
  const collectionOf = (name: string, collection: object) =>
    new Proxy(collection, {
      get: (target, property) =>
        property === 'documents'
          ? (id?: string) => {
              const documents = (
                target as { documents: (id?: string) => object }
              ).documents(id);
              return id === undefined
                ? documentsOf(name, documents)
                : documents;
            }
          : Reflect.get(target, property, target),
    });
  return new Proxy(client, {
    get: (target, property) =>
      property === 'collections'
        ? (name?: string) =>
            name === undefined
              ? target.collections()
              : collectionOf(name, target.collections(name))
        : Reflect.get(target, property, target),
  });
}

describe('filtering across collections through declared joins', () => {
  const container = new TypesenseContainer();
  const port = 3010;
  const distribution = Distribution.sparql(
    new URL(`http://localhost:${port}/sparql`),
  );
  const source = new Dataset({
    iri: new URL('http://example.org/dataset/limburg'),
    distributions: [distribution],
  });
  // Resolve straight to the local endpoint: probing and importing are the
  // resolver’s own concern, tested with @lde/pipeline – here it is a seam.
  const resolver: DistributionResolver = {
    probe: async () => new ProbedDistributions(source, [], null),
    resolve: async () => new ResolvedDistribution(distribution, []),
  };
  let client: Client;
  let directory: string;
  /** Every import after which a referrer still pointed at a just-imported
   *  referent it could not join to. */
  const unresolvedAfterImport: string[] = [];

  /**
   * The ids of the CreativeWorks matching `iri` through `on` – the join path –
   * or on the reference field itself when the path is empty.
   */
  const hits = async (
    on: readonly string[],
    iri: string,
  ): Promise<string[]> => {
    const engine = createTypesenseSearchEngine(client, schema);
    const result = await engine.search(creativeWork, {
      where: [
        {
          or: [
            on.length === 0
              ? { field: 'dataset', in: [iri] }
              : { on, field: 'id', in: [iri] },
          ],
        },
      ],
      orderBy: [],
      limit: 10,
      offset: 0,
      facets: [],
      locale: 'nl',
    });
    return result.hits.map((hit) => hit.id);
  };

  /** How many CreativeWorks the two-hop join reaches from `publishers`. */
  const joinedWorks = async (publishers: readonly string[]) => {
    const engine = createTypesenseSearchEngine(client, schema);
    const result = await engine.search(creativeWork, {
      where: [
        { or: [{ on: ['dataset', 'publisher'], field: 'id', in: publishers }] },
      ],
      orderBy: [],
      limit: 0,
      offset: 0,
      facets: [],
      locale: 'nl',
    });
    return result.total;
  };

  /**
   * Record whether every referrer pointing at the documents just imported
   * into `collection` already joins to them. A reference Typesense back-filled
   * only after the import returned would overlap the next import into the
   * referrer’s collection, which no lock around the import call can prevent.
   */
  const checkBackFilled = async (
    collection: string,
    documents: readonly { readonly id: string }[],
  ) => {
    const referrer = REFERRERS[collection];
    if (referrer === undefined) {
      return;
    }
    const ids = documents.map((document) => `\`${document.id}\``).join(',');
    // Through `multi_search`, whose filter travels in the body: a batch’s ids
    // overrun a GET search’s query-string limit.
    const found = async (filter: string) => {
      const { results } = (await client.multiSearch.perform({
        searches: [
          {
            collection: referrer.collection,
            q: '*',
            filter_by: filter,
            per_page: 0,
          },
        ],
      })) as { results: { found?: number }[] };
      return results[0]?.found;
    };
    const pointing = await found(`${referrer.field}:=[${ids}]`);
    const joined = await found(`$${collection}(id:=[${ids}])`);
    if (joined !== pointing) {
      unresolvedAfterImport.push(
        `${collection}: ${joined} of ${pointing} ${referrer.collection} joined`,
      );
    }
  };

  beforeAll(async () => {
    client = await container.start();
    directory = await mkdtemp(join(tmpdir(), 'lde-joins-'));
    const data = join(directory, 'joins.ttl');
    const fixture = await readFile(
      fileURLToPath(new URL('./fixtures/joins-sample.ttl', import.meta.url)),
      'utf8',
    );
    await writeFile(data, `${fixture}\n${bulkTurtle()}\n`);
    await startSparqlEndpoint(port, data);

    const stageFailures: Error[] = [];
    const reporter: Reporter = {
      onEvent: (event) => {
        if (event.type === 'stageFailed') stageFailures.push(event.error);
      },
    };
    // ONE run, on empty collections. Per-type stages import into the three
    // collections concurrently, and Typesense 30.2 permanently loses a
    // reference written while its referent’s collection is being imported –
    // so every join below resolving is what the writer’s join-component
    // import lock buys (ADR 39).
    await searchIndexerPipeline({
      schema,
      datasets: [source],
      distributionResolver: resolver,
      writerFor: (searchType: RootType, mounted) =>
        new InPlaceRebuild(
          observingImports(client, checkBackFilled),
          searchType,
          { schema: mounted, batchSize: BATCH_SIZE },
        ),
      reporter,
    }).run();
    expect(stageFailures).toEqual([]);
  }, 240_000);

  afterAll(async () => {
    await teardownSparqlEndpoint();
    await container.stop();
    await rm(directory, { recursive: true, force: true });
  });

  it('back-fills every reference before the import of its referent returns', () => {
    expect(unresolvedAfterImport).toEqual([]);
  });

  it('resolves every join of one run over overlapping imports', async () => {
    expect(
      await joinedWorks(
        Array.from(
          { length: BULK_PUBLISHERS },
          (_, index) => `https://ex/pub/bulk/${index}`,
        ),
      ),
    ).toBe(BULK_WORKS);
  });

  it('declares each joinable reference as a Typesense reference field', async () => {
    const works = await client.collections('creative_works').retrieve();
    expect(
      works.fields.find((field) => field.name === 'dataset'),
    ).toMatchObject({
      reference: 'datasets.id',
      async_reference: true,
      cascade_delete: false,
    });
  });

  it('resolves the references a referrer-first indexing run left dangling', async () => {
    // The declaration puts `CreativeWork` first, so its documents are imported
    // before the `datasets` and `publishers` they point at and every reference
    // dangles at import time. `async_reference` is what makes the engine ACCEPT
    // them rather than 400 (which, under `throwOnFail: false`, would drop the
    // documents in silence) – and the referents’ later imports back-fill them.
    // See the reference-back-fill test in `@lde/search-typesense` for the
    // engine guarantee itself.
    expect(
      await hits(['dataset', 'publisher'], 'https://ex/pub/limburg'),
    ).toEqual(['https://ex/cw/1']);
  });

  it('answers the two-hop motivating query in one round-trip', async () => {
    // “Every object published by institution X”: one query, one round-trip,
    // with a correct total – instead of listing the institution’s datasets and
    // then querying the works of each.
    expect(
      await hits(['dataset', 'publisher'], 'https://ex/pub/amsterdam'),
    ).toEqual(['https://ex/cw/2']);
  });

  it('filters one hop out, and by the ids the field itself holds', async () => {
    // One hop: a condition on the referent.
    expect(await hits(['dataset'], 'https://ex/ds/amsterdam')).toEqual([
      'https://ex/cw/2',
    ]);
    // No hop: the ids the reference field itself holds. Unchanged by
    // `joinable` – and here, the same answer by a different route.
    expect(await hits([], 'https://ex/ds/amsterdam')).toEqual([
      'https://ex/cw/2',
    ]);
  });

  it('rejects a path the schema does not declare, before dispatching it', async () => {
    const engine = createTypesenseSearchEngine(client, schema);
    await expect(
      engine.search(creativeWork, {
        where: [{ or: [{ on: ['label'], field: 'id', in: ['x'] }] }],
        orderBy: [],
        limit: 10,
        offset: 0,
        facets: [],
        locale: 'nl',
      }),
    ).rejects.toThrow(/“label.id” \(unknown-join\)/);
  });
});
