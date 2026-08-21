import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { beforeEach, describe, expect, it } from 'vitest';
import { printSchemaModuleSdl } from '../src/print-sdl.js';

const fixture = (name: string): string =>
  fileURLToPath(new URL(`./fixtures/${name}`, import.meta.url));

let directory: string;

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), 'lde-print-sdl-'));
});

describe('printSchemaModuleSdl', () => {
  it('prints the contract of the mounted module', async () => {
    const sdl = await printSchemaModuleSdl({
      modulePath: fixture('no-options.mjs'),
    });

    expect(sdl).toContain('type Query {');
    expect(sdl).toContain('datasets(');
  });

  it('forwards the module’s schemaOptions', async () => {
    const sdl = await printSchemaModuleSdl({
      modulePath: fixture('search-schema.mjs'),
    });

    expect(sdl).toContain('catalogue(');
    expect(sdl).not.toContain('datasets(');
  });

  it('writes the SDL to the output path', async () => {
    const outputPath = join(directory, 'schema.graphql');

    const sdl = await printSchemaModuleSdl({
      modulePath: fixture('no-options.mjs'),
      outputPath,
    });

    await expect(readFile(outputPath, 'utf8')).resolves.toBe(sdl);
  });

  it('formats with the Prettier configuration that applies to the output', async () => {
    await writeFile(
      join(directory, '.prettierrc'),
      JSON.stringify({ tabWidth: 4 }),
      'utf8',
    );

    const sdl = await printSchemaModuleSdl({
      modulePath: fixture('no-options.mjs'),
      outputPath: join(directory, 'schema.graphql'),
    });

    expect(sdl).toContain('\n    datasets(');
  });

  it('honours .editorconfig, as the Prettier CLI does', async () => {
    await writeFile(
      join(directory, '.editorconfig'),
      '[*]\nindent_size = 8\n',
      'utf8',
    );

    const sdl = await printSchemaModuleSdl({
      modulePath: fixture('no-options.mjs'),
      outputPath: join(directory, 'schema.graphql'),
    });

    expect(sdl).toContain('\n        datasets(');
  });

  it('formats an output path Prettier cannot infer a parser from', async () => {
    const sdl = await printSchemaModuleSdl({
      modulePath: fixture('no-options.mjs'),
      outputPath: join(directory, 'schema.sdl'),
    });

    expect(sdl).toContain('type Query {');
  });

  it('leaves the SDL as GraphQL prints it when formatting is off', async () => {
    const unformatted = await printSchemaModuleSdl({
      modulePath: fixture('no-options.mjs'),
      format: false,
    });
    const formatted = await printSchemaModuleSdl({
      modulePath: fixture('no-options.mjs'),
    });

    // Prettier expands every one-line description into a block, so a wording
    // change stays one changed line in the committed diff.
    expect(unformatted).toContain('"""1-based page number; at least 1."""');
    expect(formatted).toContain('    1-based page number; at least 1.\n');
    expect(formatted).not.toBe(unformatted);
  });

  it('rejects a non-object schemaOptions, naming the module', async () => {
    await expect(
      printSchemaModuleSdl({ modulePath: fixture('invalid-options.mjs') }),
    ).rejects.toThrowError(
      /invalid-options\.mjs” export “schemaOptions” must be an object/,
    );
  });

  it('rejects a missing module, naming the path', async () => {
    await expect(
      printSchemaModuleSdl({ modulePath: '/no/such/module.mjs' }),
    ).rejects.toThrowError(
      /Cannot load schema module “\/no\/such\/module\.mjs”/,
    );
  });
});
