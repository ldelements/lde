import * as sparqlQlever from '@lde/sparql-qlever';
import { describe, expect, it, vi } from 'vitest';
import { distributionResolverFrom } from '../src/composition.js';
import { configFromEnvironment } from '../src/config.js';

vi.mock('@lde/sparql-qlever', async (importOriginal) => {
  const original = await importOriginal<typeof sparqlQlever>();
  return { ...original, createQlever: vi.fn(original.createQlever) };
});

const minimal = {
  REGISTRY_ENDPOINT: 'https://registry.example.org/sparql',
  TYPESENSE_HOST: 'typesense.internal',
  TYPESENSE_API_KEY: 'admin-key',
};

function serverOptionsFor(environment: Record<string, string>) {
  vi.mocked(sparqlQlever.createQlever).mockClear();
  distributionResolverFrom(
    configFromEnvironment({
      ...minimal,
      DATA_DIR: '/tmp/qlever-data',
      ...environment,
    }),
  );
  return vi.mocked(sparqlQlever.createQlever).mock.calls[0]?.[0].serverOptions;
}

describe('the QLever server’s memory cap', () => {
  it('passes QLEVER_MEMORY_MAX_SIZE to the server', () => {
    expect(
      serverOptionsFor({
        QLEVER_IMAGE: 'adfreiburg/qlever:latest',
        QLEVER_MEMORY_MAX_SIZE: '8G',
      }),
    ).toEqual({ 'memory-max-size': '8G' });
  });

  it('passes it on a Docker network and to a sidecar alike', () => {
    expect(
      serverOptionsFor({
        QLEVER_IMAGE: 'adfreiburg/qlever:latest',
        QLEVER_NETWORK: 'app_default',
        QLEVER_MEMORY_MAX_SIZE: '8G',
      }),
    ).toEqual({ 'memory-max-size': '8G' });
    expect(
      serverOptionsFor({ QLEVER_MODE: 'remote', QLEVER_MEMORY_MAX_SIZE: '8G' }),
    ).toEqual({ 'memory-max-size': '8G' });
  });

  it('leaves the server its own default when unset', () => {
    expect(
      serverOptionsFor({ QLEVER_IMAGE: 'adfreiburg/qlever:latest' }),
    ).toBeUndefined();
  });
});
