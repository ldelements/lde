import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { loadSchemaModule } from '../src/module.js';

const fixture = (name: string): string =>
  fileURLToPath(new URL(`./fixtures/module/${name}`, import.meta.url));

describe('loadSchemaModule', () => {
  it('builds the validated schema from the default export', async () => {
    const { schema, moduleExports } = await loadSchemaModule(
      fixture('search-schema.mjs'),
    );
    const types = [...schema.values()];
    expect(types).toHaveLength(1);
    expect(types[0]!.name).toBe('Dataset');
    expect(moduleExports['schemaOptions']).toEqual({ maxPerPage: 50 });
  });

  it('rejects a missing file, naming the path', async () => {
    await expect(loadSchemaModule('/no/such/module.mjs')).rejects.toThrowError(
      /Cannot load schema module “\/no\/such\/module\.mjs”/,
    );
  });

  it('rejects a module that throws a non-Error value', async () => {
    await expect(
      loadSchemaModule(fixture('throws-string.mjs')),
    ).rejects.toThrowError(/Cannot load schema module .*boom/);
  });

  it('rejects a default export that is not an array', async () => {
    await expect(
      loadSchemaModule(fixture('not-an-array.mjs')),
    ).rejects.toThrowError(/must default-export a non-empty array/);
  });

  it('rejects an empty default export', async () => {
    await expect(
      loadSchemaModule(fixture('empty-array.mjs')),
    ).rejects.toThrowError(/must default-export a non-empty array/);
  });

  it('rejects invalid declarations with the validation diagnosis', async () => {
    await expect(
      loadSchemaModule(fixture('invalid-declaration.mjs')),
    ).rejects.toThrowError(/declares an invalid schema/);
  });
});
