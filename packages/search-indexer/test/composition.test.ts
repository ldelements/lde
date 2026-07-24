import { ImportResolver, RegistrySelector } from '@lde/pipeline';
import { searchSchema } from '@lde/search';
import { BlueGreenRebuild, InPlaceRebuild } from '@lde/search-typesense';
import { Client } from 'typesense';
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

describe('datasetSelectorFrom', () => {
  it('selects from the configured registry', () => {
    const selector = datasetSelectorFrom(configFromEnvironment(minimal));
    expect(selector).toBeInstanceOf(RegistrySelector);
  });
});

describe('writerFactoryFrom', () => {
  it('builds an in-place rebuild writer by default', () => {
    const writerFor = writerFactoryFrom(client, configFromEnvironment(minimal));
    const writer = writerFor(datasetType);
    expect(writer).toBeInstanceOf(InPlaceRebuild);
    expect((writer as InPlaceRebuild<never>).collectionName).toBe('datasets');
  });

  it('builds a blue-green rebuild writer when configured', () => {
    const writerFor = writerFactoryFrom(
      client,
      configFromEnvironment({ ...minimal, REBUILD_MODE: 'blue-green' }),
    );
    const writer = writerFor(datasetType);
    expect(writer).toBeInstanceOf(BlueGreenRebuild);
    expect((writer as BlueGreenRebuild<never>).collectionName).toBe('datasets');
  });

  it('prefixes the derived collection name when configured', () => {
    const writerFor = writerFactoryFrom(
      client,
      configFromEnvironment({ ...minimal, COLLECTION_PREFIX: 'staging_' }),
    );
    const writer = writerFor(datasetType);
    expect((writer as InPlaceRebuild<never>).collectionName).toBe(
      'staging_datasets',
    );
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
});
