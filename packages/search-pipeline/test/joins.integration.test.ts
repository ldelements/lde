import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Client } from 'typesense';
import { Dataset, Distribution } from '@lde/dataset';
import {
  ProbedDistributions,
  ResolvedDistribution,
  type DistributionResolver,
  type ProgressReporter,
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

  beforeAll(async () => {
    client = await container.start();
    await startSparqlEndpoint(
      port,
      fileURLToPath(new URL('./fixtures/joins-sample.ttl', import.meta.url)),
    );

    const stageFailures: Error[] = [];
    const reporter: ProgressReporter = {
      stageFailed: (_stage, error) => {
        stageFailures.push(error);
      },
    };
    const index = async () =>
      searchIndexerPipeline({
        schema,
        datasets: [source],
        distributionResolver: resolver,
        writerFor: (searchType: RootType, mounted) =>
          new InPlaceRebuild(client, searchType, { schema: mounted }),
        reporter,
      }).run();
    // TWICE, deliberately. Per-type stages import into the referring and the
    // referenced collection CONCURRENTLY, and Typesense 30.2 permanently loses
    // a reference written in that window (see the ADR’s limitations). A second
    // run meets referents that already exist, so every reference resolves at
    // write time. Once the engine fixes the race, one run will do.
    await index();
    await index();
    expect(stageFailures).toEqual([]);
  }, 240_000);

  afterAll(async () => {
    await teardownSparqlEndpoint();
    await container.stop();
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
    // documents in silence) – so the run before this one left an index whose
    // values are all present, and the run after it resolved the references. See
    // the reference-back-fill test in `@lde/search-typesense` for the engine
    // guarantee itself, and the ADR for why one run is not yet enough.
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
