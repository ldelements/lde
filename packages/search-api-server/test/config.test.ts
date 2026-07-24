import { describe, expect, it } from 'vitest';
import { configFromEnvironment } from '../src/config.js';

const minimal = {
  TYPESENSE_HOST: 'typesense.internal',
  TYPESENSE_API_KEY: 'search-only-key',
};

describe('configFromEnvironment', () => {
  it('applies defaults with only the required variables set', () => {
    const config = configFromEnvironment(minimal);
    expect(config).toEqual({
      schemaModulePath: '/config/search-schema.mjs',
      port: 4000,
      graphqlEndpoint: '/graphql',
      playground: true,
      maxDepth: undefined,
      maxCost: undefined,
      typesense: {
        host: 'typesense.internal',
        port: 8108,
        protocol: 'http',
        apiKey: 'search-only-key',
      },
    });
  });

  it('reads every override', () => {
    const config = configFromEnvironment({
      ...minimal,
      SCHEMA_MODULE: '/mnt/schema.mjs',
      PORT: '8080',
      GRAPHQL_ENDPOINT: '/api/graphql',
      PLAYGROUND: 'false',
      MAX_DEPTH: '10',
      MAX_COST: '1000',
      TYPESENSE_PORT: '443',
      TYPESENSE_PROTOCOL: 'https',
    });
    expect(config).toEqual({
      schemaModulePath: '/mnt/schema.mjs',
      port: 8080,
      graphqlEndpoint: '/api/graphql',
      playground: false,
      maxDepth: 10,
      maxCost: 1000,
      typesense: {
        host: 'typesense.internal',
        port: 443,
        protocol: 'https',
        apiKey: 'search-only-key',
      },
    });
  });

  it('reports all problems in one error', () => {
    let message = '';
    try {
      configFromEnvironment({ PORT: 'eighty', TYPESENSE_PROTOCOL: 'ftp' });
    } catch (error) {
      message = (error as Error).message;
    }
    expect(message).toContain('PORT must be a non-negative integer');
    expect(message).toContain('TYPESENSE_PROTOCOL must be “http” or “https”');
    expect(message).toContain('TYPESENSE_HOST is required');
    expect(message).toContain('TYPESENSE_API_KEY is required');
  });

  it('disables the playground case-insensitively', () => {
    expect(
      configFromEnvironment({ ...minimal, PLAYGROUND: 'FALSE' }).playground,
    ).toBe(false);
  });

  it('rejects a relative GraphQL endpoint', () => {
    expect(() =>
      configFromEnvironment({ ...minimal, GRAPHQL_ENDPOINT: 'graphql' }),
    ).toThrowError(/GRAPHQL_ENDPOINT must be an absolute path/);
  });

  it('treats an empty required variable as missing', () => {
    expect(() =>
      configFromEnvironment({ ...minimal, TYPESENSE_API_KEY: '' }),
    ).toThrowError(/TYPESENSE_API_KEY is required/);
  });
});
