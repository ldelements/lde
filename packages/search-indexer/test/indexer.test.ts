import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Pipeline } from '@lde/pipeline';
import { describe, expect, it } from 'vitest';
import { configFromEnvironment } from '../src/config.js';
import { createSearchIndexer } from '../src/indexer.js';

const fixture = fileURLToPath(
  new URL('./fixtures/search-schema.mjs', import.meta.url),
);

const minimal = {
  REGISTRY_ENDPOINT: 'https://registry.example.org/sparql',
  TYPESENSE_HOST: 'typesense.internal',
  TYPESENSE_API_KEY: 'admin-key',
};

describe('createSearchIndexer', () => {
  it('composes a ready-to-run pipeline from config and schema module', async () => {
    const pipeline = await createSearchIndexer(
      configFromEnvironment({
        ...minimal,
        SCHEMA_MODULE: fixture,
        PROVENANCE_FILE: '/state/provenance.json',
        PIPELINE_VERSION: '1',
      }),
    );
    expect(pipeline).toBeInstanceOf(Pipeline);
  });

  it('composes without provenance when none is configured', async () => {
    const pipeline = await createSearchIndexer(
      configFromEnvironment({ ...minimal, SCHEMA_MODULE: fixture }),
    );
    expect(pipeline).toBeInstanceOf(Pipeline);
  });

  it('routes the configured root types to the registry endpoint', async () => {
    const pipeline = await createSearchIndexer(
      configFromEnvironment({
        ...minimal,
        SCHEMA_MODULE: fixture,
        REGISTRY_ROOT_TYPES: 'Dataset',
      }),
    );
    expect(pipeline).toBeInstanceOf(Pipeline);
  });

  it('fails the boot on a registry root type the schema does not declare', async () => {
    // At boot, not per dataset: the type would otherwise read the dataset’s
    // distribution and ship an empty collection.
    await expect(
      createSearchIndexer(
        configFromEnvironment({
          ...minimal,
          SCHEMA_MODULE: fixture,
          REGISTRY_ROOT_TYPES: 'Publisher',
        }),
      ),
    ).rejects.toThrowError(/Unknown registry root type\(s\) “Publisher”/);
  });

  it('fails the boot on a restricted root type the schema does not declare', async () => {
    // Proves RESTRICT_ROOTS reaches the pipeline: a misspelt name would
    // otherwise restrict nothing and index every root.
    await expect(
      createSearchIndexer(
        configFromEnvironment({
          ...minimal,
          SCHEMA_MODULE: fixture,
          RESTRICT_ROOTS: '{"Publisher": "?root a ?type"}',
        }),
      ),
    ).rejects.toThrowError(/Unknown restricted root type\(s\) “Publisher”/);
  });

  describe('STORED_FILTERS_FILE', () => {
    const withFile = async (content: string) => {
      const directory = await mkdtemp(join(tmpdir(), 'stored-filters-'));
      const path = join(directory, 'stored-filters.json');
      await writeFile(path, content);
      return createSearchIndexer(
        configFromEnvironment({
          ...minimal,
          SCHEMA_MODULE: fixture,
          STORED_FILTERS_FILE: path,
        }),
      );
    };

    it('fails the boot on a filter the schema cannot serve', async () => {
      // Proves the file reaches the pipeline: the fixture’s type declares no
      // field to hold a filter’s value.
      await expect(
        withFile(
          JSON.stringify([
            {
              type: 'Dataset',
              value: 'open',
              filter: {
                op: 'a_contains',
                args: [{ property: 'keyword' }, ['open']],
              },
            },
          ]),
        ),
      ).rejects.toThrowError(
        /Stored filter 1 names type “Dataset”, which declares no field/,
      );
    });

    it('fails the boot on a file that is not JSON, naming it', async () => {
      await expect(withFile('{oops')).rejects.toThrowError(
        /STORED_FILTERS_FILE “.*stored-filters\.json” is not valid JSON/,
      );
    });

    it('fails the boot on a file that holds no list, naming it', async () => {
      await expect(withFile('{"filters": []}')).rejects.toThrowError(
        /STORED_FILTERS_FILE “.*stored-filters\.json” must hold a JSON array/,
      );
    });

    it('fails the boot on a file it cannot read, naming it', async () => {
      await expect(
        createSearchIndexer(
          configFromEnvironment({
            ...minimal,
            SCHEMA_MODULE: fixture,
            STORED_FILTERS_FILE: '/nowhere/stored-filters.json',
          }),
        ),
      ).rejects.toThrowError(
        /STORED_FILTERS_FILE “\/nowhere\/stored-filters\.json” cannot be read/,
      );
    });
  });

  it('fails the boot on a tuned type the schema does not declare', async () => {
    // Proves EXTRACTION_TUNING reaches the pipeline.
    await expect(
      createSearchIndexer(
        configFromEnvironment({
          ...minimal,
          SCHEMA_MODULE: fixture,
          EXTRACTION_TUNING: '{"Publisher": {"batchSize": 100}}',
        }),
      ),
    ).rejects.toThrowError(/Unknown tuned type\(s\) “Publisher”/);
  });

  it('attaches a deployment’s transform without giving up the wiring', async () => {
    // The whole cost of adding behaviour: one option. Everything
    // createSearchIndexer wires – provenance, the reporter, registry types,
    // collection naming – stays wired, which hand-composing a Pipeline to reach
    // the reader silently gives up.
    const pipeline = await createSearchIndexer(
      configFromEnvironment({
        ...minimal,
        SCHEMA_MODULE: fixture,
        PROVENANCE_FILE: '/state/provenance.json',
        PIPELINE_VERSION: '1',
      }),
      {
        transforms: {
          Dataset: async function* (quads) {
            yield* quads;
          },
        },
      },
    );
    expect(pipeline).toBeInstanceOf(Pipeline);
  });

  it('fails the boot on a transform naming a type the schema does not declare', async () => {
    // At boot, not per dataset: the transform would otherwise attach to nothing
    // and the collection would ship unenriched.
    await expect(
      createSearchIndexer(
        configFromEnvironment({ ...minimal, SCHEMA_MODULE: fixture }),
        {
          transforms: {
            Datasets: async function* (quads) {
              yield* quads;
            },
          },
        },
      ),
    ).rejects.toThrowError(/Unknown transform type\(s\) “Datasets”/);
  });

  it('fails the boot on an unloadable schema module, naming the path', async () => {
    await expect(
      createSearchIndexer(
        configFromEnvironment({
          ...minimal,
          SCHEMA_MODULE: '/no/such/module.mjs',
        }),
      ),
    ).rejects.toThrowError(
      /Cannot load schema module “\/no\/such\/module\.mjs”/,
    );
  });
});
