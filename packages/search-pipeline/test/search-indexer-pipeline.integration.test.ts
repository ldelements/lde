import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Dataset, Distribution } from '@lde/dataset';
import {
  ProbedDistributions,
  ResolvedDistribution,
  type DistributionResolver,
  type ProgressReporter,
  type Writer,
} from '@lde/pipeline';
import {
  defineSearchType,
  searchSchema,
  type RootType,
  type SearchDocument,
} from '@lde/search';
import {
  startSparqlEndpoint,
  teardownSparqlEndpoint,
} from '@lde/local-sparql-endpoint';
import { searchIndexerPipeline } from '../src/search-indexer-pipeline.js';

const SCHEMA = 'https://schema.org/';

// The Drapo-shaped schema of the extraction round-trip test, both types root:
// the convenience derives one stage and one collection per root type.
const person = defineSearchType({
  name: 'Person',
  class: `${SCHEMA}Person`,
  fields: [
    {
      name: 'label',
      kind: 'text',
      path: `<${SCHEMA}name>`,
      locales: ['und'],
      output: true,
      searchable: { weight: 3 },
    },
  ],
});

const creativeWork = defineSearchType({
  name: 'CreativeWork',
  class: `${SCHEMA}CreativeWork`,
  fields: [
    {
      name: 'name',
      kind: 'text',
      path: `<${SCHEMA}name>`,
      locales: ['nl', 'en'],
      output: true,
      searchable: { weight: 5 },
    },
  ],
});

const schema = searchSchema(creativeWork, person);

describe('searchIndexerPipeline end to end', () => {
  const port = 3008;
  const distribution = Distribution.sparql(
    new URL(`http://localhost:${port}/sparql`),
  );
  const dataset = new Dataset({
    iri: new URL('http://example.org/dataset/drapo'),
    distributions: [distribution],
  });

  // Resolve straight to the local endpoint: probing and importing are the
  // resolver’s own concern, tested with @lde/pipeline – here it is a seam.
  const resolver: DistributionResolver = {
    probe: async () => new ProbedDistributions(dataset, [], null),
    resolve: async () => new ResolvedDistribution(distribution, []),
  };

  beforeAll(async () => {
    const fixture = fileURLToPath(
      new URL('./fixtures/drapo-sample.ttl', import.meta.url),
    );
    await startSparqlEndpoint(port, fixture);
  }, 60_000);

  afterAll(async () => {
    await teardownSparqlEndpoint();
  });

  it('indexes every root type’s IRI roots into its own committed collection', async () => {
    const received = new Map<string, SearchDocument[]>();
    const committed: string[] = [];
    const writerFor = (searchType: RootType): Writer<SearchDocument> => ({
      openRun: async () => ({
        write: async (_dataset, documents) => {
          const collection = received.get(searchType.name) ?? [];
          received.set(searchType.name, collection);
          for await (const document of documents) {
            collection.push(document);
          }
        },
        commit: async () => {
          committed.push(searchType.name);
        },
        abort: async () => undefined,
      }),
    });

    // The pipeline isolates a stage failure per dataset instead of throwing
    // (e.g. framing crashing on a blank-node root), so capture it explicitly.
    const stageFailures: Error[] = [];
    const reporter: ProgressReporter = {
      stageFailed: (_stage, error) => {
        stageFailures.push(error);
      },
    };

    await searchIndexerPipeline({
      schema,
      datasets: [dataset],
      distributionResolver: resolver,
      writerFor,
      reporter,
    }).run();

    expect(stageFailures).toEqual([]);
    // Both roots per type – and not the fixture’s blank-node CreativeWork,
    // which selectByClass must exclude (it has no stable document key).
    expect(
      received
        .get('CreativeWork')
        ?.map((document) => document.id)
        .sort(),
    ).toEqual(['https://ex/cw/1', 'https://ex/cw/2']);
    expect(received.get('Person')?.map((document) => document.id)).toEqual([
      'https://ex/p/1',
    ]);
    expect(committed.sort()).toEqual(['CreativeWork', 'Person']);
  });
});
