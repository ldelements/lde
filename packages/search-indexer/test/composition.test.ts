import { ImportResolver, Pipeline, RegistrySelector } from '@lde/pipeline';
import { searchSchema } from '@lde/search';
import {
  searchIndexWriter,
  searchStages,
  selectByClass,
} from '@lde/search-pipeline';
import { BlueGreenRebuild, InPlaceRebuild } from '@lde/search-typesense';
import { Client } from 'typesense';
import type { CollectionCreateSchema } from 'typesense/lib/Typesense/Collections.js';
import { describe, expect, it } from 'vitest';
import {
  datasetSelectorFrom,
  distributionResolverFrom,
  writerFactoryFrom,
} from '../src/composition.js';
import { configFromEnvironment } from '../src/config.js';

const minimal = {
  REGISTRY_ENDPOINT: 'https://registry.example.org/sparql',
  TYPESENSE_HOST: 'typesense.internal',
  TYPESENSE_API_KEY: 'admin-key',
};

const client = new Client({
  nodes: [{ host: 'typesense.internal', port: 8108, protocol: 'http' }],
  apiKey: 'admin-key',
});

const schema = searchSchema({
  name: 'Dataset',
  class: 'http://www.w3.org/ns/dcat#Dataset',
  fields: [{ name: 'title', kind: 'text', locales: ['en'], output: true }],
});
const datasetType = [...schema.values()][0]!;

/** A type whose searchable text carries no language tag – the `und` locale
 *  whose stemming `defaultLocale` decides. */
const untaggedSchema = searchSchema({
  name: 'Dataset',
  class: 'http://www.w3.org/ns/dcat#Dataset',
  fields: [
    {
      name: 'title',
      kind: 'text',
      // A field the projection reads needs a path even when a transform is what
      // fills it: projection skips a field with neither a path nor a derive.
      path: '<http://purl.org/dc/terms/title>',
      locales: ['und'],
      output: true,
      searchable: { weight: 1 },
    },
  ],
});
const untaggedType = [...untaggedSchema.values()][0]!;

/**
 * A Typesense client that records the collections a writer creates: the lock
 * is granted, the target collection is reported missing (404), and the
 * definition the writer then creates is captured. Enough of the client for
 * `openRun` to reach the create – the definition is what these tests assert.
 */
function recordingClient(): {
  client: Client;
  created: CollectionCreateSchema[];
} {
  const created: CollectionCreateSchema[] = [];
  const notFound = Object.assign(new Error('HTTP 404'), { httpStatus: 404 });
  const client = {
    collections: (name?: string) =>
      name === undefined
        ? {
            create: async (schema: CollectionCreateSchema) => {
              created.push(schema);
              return schema;
            },
          }
        : {
            retrieve: async () => {
              throw notFound;
            },
            documents: () => ({ create: async () => ({}) }),
          },
  } as unknown as Client;
  return { client, created };
}

/** The physical field a definition declares under `name`. */
function field(
  definition: CollectionCreateSchema,
  name: string,
): Record<string, unknown> {
  const found = definition.fields?.find((each) => each.name === name);
  expect(
    found,
    `no field “${name}” in the collection definition`,
  ).toBeDefined();
  return found as unknown as Record<string, unknown>;
}

const runContext = {
  runId: 'run-1',
  startedAt: '2026-07-06T12:00:00.000Z',
  selectedSources: () => [],
};

describe('datasetSelectorFrom', () => {
  it('selects from the configured registry', () => {
    const selector = datasetSelectorFrom(configFromEnvironment(minimal));
    expect(selector).toBeInstanceOf(RegistrySelector);
  });
});

describe('writerFactoryFrom', () => {
  it('builds an in-place rebuild writer by default', () => {
    const writerFor = writerFactoryFrom(client, configFromEnvironment(minimal));
    const writer = writerFor(datasetType, schema);
    expect(writer).toBeInstanceOf(InPlaceRebuild);
    expect((writer as InPlaceRebuild<never>).collectionName).toBe('datasets');
  });

  it('builds a blue-green rebuild writer when configured', () => {
    const writerFor = writerFactoryFrom(
      client,
      configFromEnvironment({ ...minimal, REBUILD_MODE: 'blue-green' }),
    );
    const writer = writerFor(datasetType, schema);
    expect(writer).toBeInstanceOf(BlueGreenRebuild);
    expect((writer as BlueGreenRebuild<never>).collectionName).toBe('datasets');
  });

  it('prefixes the derived collection name when configured', () => {
    const writerFor = writerFactoryFrom(
      client,
      configFromEnvironment({ ...minimal, COLLECTION_PREFIX: 'staging_' }),
    );
    const writer = writerFor(datasetType, schema);
    expect((writer as InPlaceRebuild<never>).collectionName).toBe(
      'staging_datasets',
    );
  });

  it('leaves untagged text unstemmed without DEFAULT_LOCALE', async () => {
    const { client: recorder, created } = recordingClient();
    const writerFor = writerFactoryFrom(
      recorder,
      configFromEnvironment(minimal),
    );
    await writerFor(untaggedType, untaggedSchema).openRun(runContext);
    expect(field(created[0]!, 'title_search_und')).not.toHaveProperty('stem');
  });

  it('stems untagged text in the configured DEFAULT_LOCALE', async () => {
    // Configuration, not code: the Docker image reaches this too, so a Dutch
    // deployment does not fold-without-stemming (“fietsen” vs “fiets”).
    const { client: recorder, created } = recordingClient();
    const writerFor = writerFactoryFrom(
      recorder,
      configFromEnvironment({ ...minimal, DEFAULT_LOCALE: 'nl' }),
    );
    await writerFor(untaggedType, untaggedSchema).openRun(runContext);
    expect(field(created[0]!, 'title_search_und')).toMatchObject({
      stem: true,
      locale: 'nl',
    });
  });
});

describe('distributionResolverFrom', () => {
  it('leaves the pipeline its endpoint-only default without QLEVER_IMAGE', () => {
    expect(
      distributionResolverFrom(configFromEnvironment(minimal)),
    ).toBeUndefined();
  });

  it('builds the QLever import path when configured', () => {
    const resolver = distributionResolverFrom(
      configFromEnvironment({
        ...minimal,
        QLEVER_IMAGE: 'adfreiburg/qlever:latest',
        IMPORT_STRATEGY: 'import',
        DATA_DIR: '/tmp/qlever-data',
      }),
    );
    expect(resolver).toBeInstanceOf(ImportResolver);
  });

  it('builds the QLever import path on a Docker network', () => {
    const resolver = distributionResolverFrom(
      configFromEnvironment({
        ...minimal,
        QLEVER_IMAGE: 'adfreiburg/qlever:latest',
        IMPORT_STRATEGY: 'import',
        DATA_DIR: '/tmp/qlever-data',
        QLEVER_NETWORK: 'app_default',
      }),
    );
    expect(resolver).toBeInstanceOf(ImportResolver);
  });
});

describe('the composed route', () => {
  it('wires the helpers into a Pipeline, as the reference documents', () => {
    // The worked example in docs/reference/search-indexer.md, asserted here so
    // it cannot rot while createSearchIndexer keeps passing: a deployment
    // reaches SearchStageType.readers – its transform – while the helpers keep
    // dataset selection, the import path and collection naming.
    const config = configFromEnvironment(minimal);
    const pipeline = new Pipeline({
      datasetSelector: datasetSelectorFrom(config),
      distributionResolver: distributionResolverFrom(config),
      stages: searchStages({
        schema: untaggedSchema,
        types: [
          {
            searchType: untaggedType,
            rootVariable: 'root',
            itemSelector: selectByClass(untaggedType),
          },
        ],
      }),
      writers: searchIndexWriter({
        schema: untaggedSchema,
        writerFor: writerFactoryFrom(client, config),
      }),
    });
    expect(pipeline).toBeInstanceOf(Pipeline);
  });
});
