import { describe, expect, it } from 'vitest';
import { configFromEnvironment } from '../src/config.js';

const minimal = {
  REGISTRY_ENDPOINT: 'https://registry.example.org/sparql',
  TYPESENSE_HOST: 'typesense.internal',
  TYPESENSE_API_KEY: 'admin-key',
};

describe('configFromEnvironment', () => {
  it('applies defaults with only the required variables set', () => {
    const config = configFromEnvironment(minimal);
    expect(config).toEqual({
      schemaModulePath: '/config/search-schema.mjs',
      registryEndpoint: new URL('https://registry.example.org/sparql'),
      registryRootTypes: [],
      datasetCriteria: {},
      localSources: [],
      typesense: {
        host: 'typesense.internal',
        port: 8108,
        protocol: 'http',
        apiKey: 'admin-key',
      },
      rebuildMode: 'in-place',
      collectionPrefix: undefined,
      defaultLocale: undefined,
      provenance: undefined,
      qlever: undefined,
    });
  });

  it('reads every override', () => {
    const config = configFromEnvironment({
      ...minimal,
      SCHEMA_MODULE: '/mnt/schema.mjs',
      TYPESENSE_PORT: '443',
      TYPESENSE_PROTOCOL: 'https',
      REBUILD_MODE: 'blue-green',
      COLLECTION_PREFIX: 'staging_',
      DEFAULT_LOCALE: 'nl',
      REGISTRY_ROOT_TYPES: 'Dataset, Publisher',
      QLEVER_IMAGE: 'adfreiburg/qlever:latest',
      IMPORT_STRATEGY: 'import',
      DATA_DIR: '/mnt/data',
    });
    expect(config).toEqual({
      schemaModulePath: '/mnt/schema.mjs',
      registryEndpoint: new URL('https://registry.example.org/sparql'),
      registryRootTypes: ['Dataset', 'Publisher'],
      datasetCriteria: {},
      localSources: [],
      typesense: {
        host: 'typesense.internal',
        port: 443,
        protocol: 'https',
        apiKey: 'admin-key',
      },
      rebuildMode: 'blue-green',
      collectionPrefix: 'staging_',
      defaultLocale: 'nl',
      provenance: undefined,
      qlever: {
        mode: 'docker',
        image: 'adfreiburg/qlever:latest',
        strategy: 'import',
        dataDir: '/mnt/data',
      },
    });
  });

  it('reports all problems in one error', () => {
    let message = '';
    try {
      configFromEnvironment({
        TYPESENSE_PORT: 'eighty',
        TYPESENSE_PROTOCOL: 'ftp',
        REBUILD_MODE: 'green-blue',
      });
    } catch (error) {
      message = (error as Error).message;
    }
    expect(message).toContain('REGISTRY_ENDPOINT is required');
    expect(message).toContain('TYPESENSE_HOST is required');
    expect(message).toContain('TYPESENSE_API_KEY is required');
    expect(message).toContain('TYPESENSE_PORT must be a non-negative integer');
    expect(message).toContain('TYPESENSE_PROTOCOL must be “http” or “https”');
    expect(message).toContain(
      'REBUILD_MODE must be “in-place” or “blue-green”',
    );
  });

  it('rejects a malformed registry endpoint', () => {
    expect(() =>
      configFromEnvironment({ ...minimal, REGISTRY_ENDPOINT: 'not-a-url' }),
    ).toThrowError(/REGISTRY_ENDPOINT must be an absolute URL/);
  });

  describe('dataset selection', () => {
    it('turns DATASETS into $id criteria, splitting on whitespace and commas', () => {
      const config = configFromEnvironment({
        ...minimal,
        DATASETS:
          'https://example.org/dataset/1, https://example.org/dataset/2\nhttps://example.org/dataset/3',
      });
      expect(config.datasetCriteria).toEqual({
        $id: [
          'https://example.org/dataset/1',
          'https://example.org/dataset/2',
          'https://example.org/dataset/3',
        ],
      });
    });

    it('rejects a dataset entry that is not an IRI', () => {
      expect(() =>
        configFromEnvironment({ ...minimal, DATASETS: 'not-an-iri' }),
      ).toThrowError(/DATASETS contains “not-an-iri”, which is not an IRI/);
    });

    it('parses DATASET_CRITERIA as a JSON object', () => {
      const config = configFromEnvironment({
        ...minimal,
        DATASET_CRITERIA: '{"publisher": {"$id": "https://example.org/org"}}',
      });
      expect(config.datasetCriteria).toEqual({
        publisher: { $id: 'https://example.org/org' },
      });
    });

    it('rejects DATASET_CRITERIA that is not valid JSON', () => {
      expect(() =>
        configFromEnvironment({ ...minimal, DATASET_CRITERIA: '{oops' }),
      ).toThrowError(/DATASET_CRITERIA must be valid JSON/);
    });

    it('rejects DATASET_CRITERIA that is not an object', () => {
      expect(() =>
        configFromEnvironment({ ...minimal, DATASET_CRITERIA: '["a"]' }),
      ).toThrowError(/DATASET_CRITERIA must be a JSON object/);
    });

    it('rejects DATASETS combined with DATASET_CRITERIA', () => {
      expect(() =>
        configFromEnvironment({
          ...minimal,
          DATASETS: 'https://example.org/dataset/1',
          DATASET_CRITERIA: '{}',
        }),
      ).toThrowError(/mutually exclusive/);
    });
  });

  describe('local data in DATASETS', () => {
    const local = { ...minimal, QLEVER_IMAGE: 'adfreiburg/qlever:latest' };
    const typesenseOnly = {
      TYPESENSE_HOST: 'typesense.internal',
      TYPESENSE_API_KEY: 'admin-key',
      QLEVER_IMAGE: 'adfreiburg/qlever:latest',
    };

    it('splits registered datasets from local data', () => {
      const config = configFromEnvironment({
        ...local,
        DATASETS:
          'https://example.org/dataset/1 file:///rdf/extra.ttl file:///rdf/more/',
      });
      expect(config.datasetCriteria).toEqual({
        $id: ['https://example.org/dataset/1'],
      });
      expect(config.localSources).toEqual(['/rdf/extra.ttl', '/rdf/more/']);
      expect(config.registryEndpoint).toEqual(
        new URL('https://registry.example.org/sparql'),
      );
    });

    it('decodes a path, so it may hold what separates the list', () => {
      const config = configFromEnvironment({
        ...local,
        DATASETS: 'file:///rdf/with%20space.ttl',
      });
      expect(config.localSources).toEqual(['/rdf/with space.ttl']);
    });

    it('needs no registry for local data alone', () => {
      const config = configFromEnvironment({
        ...typesenseOnly,
        DATASETS: 'file:///rdf/extra.ttl',
      });
      expect(config.registryEndpoint).toBeUndefined();
    });

    it('ignores a configured registry for local data alone', () => {
      const config = configFromEnvironment({
        ...local,
        DATASETS: 'file:///rdf/extra.ttl',
      });
      expect(config.registryEndpoint).toBeUndefined();
    });

    it('still requires a registry beside local data', () => {
      expect(() =>
        configFromEnvironment({
          ...typesenseOnly,
          DATASETS: 'https://example.org/dataset/1 file:///rdf/extra.ttl',
        }),
      ).toThrowError(/REGISTRY_ENDPOINT is required/);
    });

    it('requires QLever', () => {
      expect(() =>
        configFromEnvironment({ ...minimal, DATASETS: 'file:///rdf/a.ttl' }),
      ).toThrowError(/requires QLEVER_IMAGE or QLEVER_MODE=remote/);
    });

    it('rejects a file whose format it cannot tell', () => {
      expect(() =>
        configFromEnvironment({ ...local, DATASETS: 'file:///rdf/notes.txt' }),
      ).toThrowError(/DATASETS contains “file:\/\/\/rdf\/notes\.txt”/);
    });

    it('rejects a URL with a host, the usual typo for a path', () => {
      expect(() =>
        configFromEnvironment({ ...local, DATASETS: 'file://rdf/a.ttl' }),
      ).toThrowError(/DATASETS contains “file:\/\/rdf\/a\.ttl”/);
    });

    it('reads a file: URL whatever the case of its scheme', () => {
      const config = configFromEnvironment({
        ...local,
        DATASETS: 'FILE:///rdf/a.ttl',
      });
      expect(config.localSources).toEqual(['/rdf/a.ttl']);
      expect(config.registryEndpoint).toBeUndefined();
    });

    it('rejects a file listed twice, or beside its directory', () => {
      let message = '';
      try {
        configFromEnvironment({
          ...local,
          DATASETS:
            'file:///rdf/a.ttl file:///rdf/a.ttl file:///rdf/more/b.ttl file:///rdf/more/',
        });
      } catch (error) {
        message = (error as Error).message;
      }
      expect(message).toContain('DATASETS lists “/rdf/a.ttl” twice');
      expect(message).toContain(
        'DATASETS lists “/rdf/more/b.ttl” and its directory',
      );
    });

    it('rejects local data with DATASET_CRITERIA', () => {
      expect(() =>
        configFromEnvironment({
          ...local,
          DATASETS: 'file:///rdf/a.ttl',
          DATASET_CRITERIA: '{}',
        }),
      ).toThrowError(/mutually exclusive/);
    });

    it('rejects a file: registry, which has no SPARQL to query', () => {
      expect(() =>
        configFromEnvironment({ ...local, REGISTRY_ENDPOINT: 'file:///rdf/' }),
      ).toThrowError(/REGISTRY_ENDPOINT must be a SPARQL endpoint/);
    });
  });

  describe('provenance', () => {
    it('requires the file and the version together', () => {
      expect(() =>
        configFromEnvironment({
          ...minimal,
          PROVENANCE_FILE: '/state/provenance.json',
        }),
      ).toThrowError(
        /PROVENANCE_FILE and PIPELINE_VERSION must be set together/,
      );
      expect(() =>
        configFromEnvironment({ ...minimal, PIPELINE_VERSION: '1' }),
      ).toThrowError(
        /PROVENANCE_FILE and PIPELINE_VERSION must be set together/,
      );
    });

    it('reads both halves', () => {
      const config = configFromEnvironment({
        ...minimal,
        PROVENANCE_FILE: '/state/provenance.json',
        PIPELINE_VERSION: '2026-07-24',
      });
      expect(config.provenance).toEqual({
        path: '/state/provenance.json',
        pipelineVersion: '2026-07-24',
      });
    });

    it('rejects provenance with blue-green rebuilds', () => {
      expect(() =>
        configFromEnvironment({
          ...minimal,
          REBUILD_MODE: 'blue-green',
          PROVENANCE_FILE: '/state/provenance.json',
          PIPELINE_VERSION: '1',
        }),
      ).toThrowError(/cannot be combined with REBUILD_MODE=blue-green/);
    });
  });

  describe('QLever import', () => {
    it('defaults to the sparql strategy and /data', () => {
      const config = configFromEnvironment({
        ...minimal,
        QLEVER_IMAGE: 'adfreiburg/qlever:latest',
      });
      expect(config.qlever).toEqual({
        mode: 'docker',
        image: 'adfreiburg/qlever:latest',
        strategy: 'sparql',
        dataDir: '/data',
      });
    });

    it('rejects an unknown strategy', () => {
      expect(() =>
        configFromEnvironment({
          ...minimal,
          QLEVER_IMAGE: 'adfreiburg/qlever:latest',
          IMPORT_STRATEGY: 'always',
        }),
      ).toThrowError(/IMPORT_STRATEGY must be one of/);
    });

    it('rejects a strategy without an image', () => {
      expect(() =>
        configFromEnvironment({ ...minimal, IMPORT_STRATEGY: 'import' }),
      ).toThrowError(
        /IMPORT_STRATEGY requires QLEVER_IMAGE or QLEVER_MODE=remote/,
      );
    });

    it('reads the Docker network QLever joins', () => {
      const config = configFromEnvironment({
        ...minimal,
        QLEVER_IMAGE: 'adfreiburg/qlever:latest',
        QLEVER_NETWORK: 'app_default',
      });
      expect(config.qlever).toMatchObject({ network: 'app_default' });
    });

    it('rejects a network without an image', () => {
      expect(() =>
        configFromEnvironment({ ...minimal, QLEVER_NETWORK: 'app_default' }),
      ).toThrowError(/QLEVER_NETWORK requires QLEVER_IMAGE/);
    });

    it('reads a QLever sidecar without an image', () => {
      const config = configFromEnvironment({
        ...minimal,
        QLEVER_MODE: 'remote',
        IMPORT_STRATEGY: 'import',
        DATA_DIR: '/mnt/data',
      });
      expect(config.qlever).toEqual({
        mode: 'remote',
        strategy: 'import',
        dataDir: '/mnt/data',
      });
    });

    it('rejects an image or network for a QLever sidecar', () => {
      let message = '';
      try {
        configFromEnvironment({
          ...minimal,
          QLEVER_MODE: 'remote',
          QLEVER_IMAGE: 'adfreiburg/qlever:latest',
          QLEVER_NETWORK: 'app_default',
        });
      } catch (error) {
        message = (error as Error).message;
      }
      expect(message).toMatch(
        /QLEVER_IMAGE cannot be combined with QLEVER_MODE=remote/,
      );
      expect(message).toMatch(
        /QLEVER_NETWORK cannot be combined with QLEVER_MODE=remote/,
      );
    });

    it('treats an empty mode as unset', () => {
      const config = configFromEnvironment({
        ...minimal,
        QLEVER_MODE: '',
        QLEVER_IMAGE: 'adfreiburg/qlever:latest',
      });
      expect(config.qlever).toMatchObject({ mode: 'docker' });
    });

    it('requires an image in Docker mode', () => {
      expect(() =>
        configFromEnvironment({ ...minimal, QLEVER_MODE: 'docker' }),
      ).toThrowError(/QLEVER_MODE=docker requires QLEVER_IMAGE/);
    });

    it('rejects an unknown mode', () => {
      expect(() =>
        configFromEnvironment({ ...minimal, QLEVER_MODE: 'native' }),
      ).toThrowError(
        /QLEVER_MODE must be one of “docker”, “remote”, got “native”/,
      );
    });
  });
});
