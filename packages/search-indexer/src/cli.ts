#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import { Command } from 'commander';
import { configFromEnvironment } from './config.js';
import { createSearchIndexer } from './indexer.js';

const { version } = JSON.parse(
  readFileSync(new URL('../package.json', import.meta.url), 'utf8'),
) as { version: string };

const program = new Command()
  .name('search-indexer')
  .description(
    'Run the object-grain search indexer: select datasets, extract and project each root type per the mounted schema module, and rebuild the Typesense collections. Configuration comes from environment variables; see the README.',
  )
  .version(version)
  .argument(
    '[datasets...]',
    'dataset IRIs to index (overrides the DATASETS environment variable)',
  )
  .option(
    '--check',
    'validate the configuration and schema module, then exit without indexing',
  );

program.parse();

try {
  const datasets = program.args;
  const config = configFromEnvironment(
    datasets.length > 0
      ? { ...process.env, DATASETS: datasets.join(' ') }
      : process.env,
  );
  const pipeline = await createSearchIndexer(config);
  if (program.opts<{ check?: boolean }>().check) {
    console.info(
      `@lde/search-indexer ${version}: configuration and schema module “${config.schemaModulePath}” are valid.`,
    );
  } else {
    await pipeline.run();
  }
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
}
