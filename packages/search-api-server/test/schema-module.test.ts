import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { loadSchemaModule } from '../src/schema-module.js';

const fixture = (name: string): string =>
  fileURLToPath(new URL(`./fixtures/${name}`, import.meta.url));

describe('loadSchemaModule', () => {
  it('builds the validated schema from the default export', async () => {
    const { searchSchema, schemaOptions, engineOptions } =
      await loadSchemaModule(fixture('search-schema.mjs'));
    const types = [...searchSchema.values()];
    expect(types).toHaveLength(1);
    expect(types[0]!.name).toBe('Dataset');
    expect(schemaOptions).toEqual({ maxPerPage: 50 });
    expect(engineOptions).toBeUndefined();
  });

  it('rejects a missing file, naming the path', async () => {
    await expect(loadSchemaModule('/no/such/module.mjs')).rejects.toThrowError(
      /Cannot load schema module “\/no\/such\/module\.mjs”/,
    );
  });

  it('rejects a default export that is not an array', async () => {
    await expect(
      loadSchemaModule(fixture('not-an-array.mjs')),
    ).rejects.toThrowError(/must default-export a non-empty array/);
  });

  it('rejects invalid declarations with the validation diagnosis', async () => {
    await expect(
      loadSchemaModule(fixture('invalid-declaration.mjs')),
    ).rejects.toThrowError(/declares an invalid schema/);
  });
});
