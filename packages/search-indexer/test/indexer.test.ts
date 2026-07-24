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
