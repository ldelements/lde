import { writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { loadSchemaModule, optionalObjectExport } from '@lde/search/module';
import { printGraphQLSchema } from './build-schema.js';
import type { BuildGraphQLSchemaOptions } from './build-schema.js';

/** What {@link printSchemaModuleSdl} needs to know. */
export interface PrintSchemaModuleSdlOptions {
  /** Path to the mounted schema-declaration module – the same file the
   *  indexer and the served API mount, so the printed contract cannot describe
   *  a different API from the one served. Its optional `schemaOptions` export
   *  is forwarded to {@link printGraphQLSchema}. */
  readonly modulePath: string;
  /** Where to write the SDL. Omit to only return it. */
  readonly outputPath?: string;
  /** Format the SDL with Prettier, resolving the config that applies to
   *  {@link outputPath} (default `true`). Keeps the file byte-identical to what
   *  a repo’s own formatter would produce, so a formatting pre-commit hook and
   *  this writer cannot spell the same schema differently and overwrite each
   *  other in turn. Requires `prettier` to be installed alongside this package.
   */
  readonly format?: boolean;
}

/**
 * Print the GraphQL contract of a mounted schema-declaration module, and
 * optionally write it to a file – the published surface consumers meet, which
 * a repository commits so every pull request that moves it shows the move.
 *
 * Returns the SDL. Throws with the module path in the message for every
 * failure mode of the module itself (unreadable, wrong export shape, invalid
 * declaration), so a broken contract build names the file to fix.
 */
export async function printSchemaModuleSdl({
  modulePath,
  outputPath,
  format = true,
}: PrintSchemaModuleSdlOptions): Promise<string> {
  const { schema, moduleExports } = await loadSchemaModule(modulePath);
  const sdl = printGraphQLSchema(
    schema,
    optionalObjectExport<BuildGraphQLSchemaOptions>(
      moduleExports,
      'schemaOptions',
      modulePath,
    ),
  );
  // Prettier resolves its config from the file it is about to format, so a
  // stdout run still has to name the path the SDL would live at.
  const filepath = resolve(outputPath ?? 'schema.graphql');
  const output = format ? await formatWithPrettier(sdl, filepath) : sdl;
  if (outputPath !== undefined) {
    await writeFile(filepath, output, 'utf8');
  }
  return output;
}

/** Prettier is an optional peer: the consumer’s own version formats the file,
 *  because matching the consumer’s repository is the whole point. */
async function formatWithPrettier(
  sdl: string,
  filepath: string,
): Promise<string> {
  let prettier: typeof import('prettier');
  try {
    prettier = await import('prettier');
  } catch (cause) {
    // Reports what went wrong rather than assuming it is missing: a broken
    // install and a plugin that throws at module scope both land here, and
    // “install prettier” is unhelpful advice for either.
    throw new Error(
      `Formatting the SDL requires “prettier”, an optional peer dependency of @lde/search-api-graphql, which could not be loaded: ${String(cause)}. Install it, or turn formatting off.`,
      { cause },
    );
  }
  return prettier.format(sdl, {
    // The CLI reads `.editorconfig` by default and the Node API does not, so
    // leaving it off would have `prettier --write` reformat what we just wrote.
    ...(await prettier.resolveConfig(filepath, { editorconfig: true })),
    filepath,
    // Named outright, so an output path Prettier cannot map to a parser (say
    // `.sdl`) formats instead of failing on an inferred-parser error.
    parser: 'graphql',
  });
}
