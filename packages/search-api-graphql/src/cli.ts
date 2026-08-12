#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import { Command } from 'commander';
import { printSchemaModuleSdl } from './print-sdl.js';

const { version } = JSON.parse(
  readFileSync(new URL('../package.json', import.meta.url), 'utf8'),
) as { version: string };

const program = new Command()
  .name('search-print-sdl')
  .description(
    'Print the GraphQL contract of a mounted @lde/search schema-declaration module: the published surface consumers meet. Commit the output so every pull request that moves the surface shows the move.',
  )
  .version(version)
  .requiredOption(
    '--module <path>',
    'path to the schema-declaration module, the same file the indexer and the served API mount',
  )
  .option('--out <path>', 'file to write the SDL to (default: standard output)')
  .option(
    '--no-format',
    'write the SDL as GraphQL prints it, instead of formatting it with the Prettier configuration that applies to the output file',
  );

program.parse();

const options = program.opts<{
  module: string;
  out?: string;
  format: boolean;
}>();

try {
  const sdl = await printSchemaModuleSdl({
    modulePath: options.module,
    outputPath: options.out,
    format: options.format,
  });
  if (options.out === undefined) {
    process.stdout.write(sdl);
  } else {
    console.info(`Wrote ${options.out}`);
  }
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
}
