#!/usr/bin/env node

import { Command, InvalidArgumentError } from 'commander';
import { generateDocumentation } from './index.js';
import packageJson from '../package.json' with { type: 'json' };

const program = new Command();

program
  .name('docgen')
  .description('Generate documentation from RDF data')
  .version(packageJson.version);

program
  .command('from-shacl')
  .description('Generate documentation from a SHACL shapes file')
  .argument(
    '<shacl-file>',
    'Path to SHACL shapes file (in any RDF serialization format)',
  )
  .argument('<template-file>', 'Path to Liquid template file')
  .option(
    '-f --frame <json-ld-frame-file>',
    'Path to a JSON-LD Frame file. Deep-merged on top of the built-in default frame, so it only needs to contain your additions.',
  )
  .option(
    '-c --context <url=file>',
    'Read the JSON-LD context at <url> from <file> instead of the web, for the jsonLdToTurtle filter. Repeat for each context.',
    collectContext,
    {},
  )
  .addHelpText(
    'after',
    `
Example:
  $ npx @lde/docgen@latest from-shacl shacl.ttl template.liquid
    `,
  )
  .action(async (rdfFile: string, templateFile: string, { frame, context }) => {
    try {
      const documentation = await generateDocumentation(
        rdfFile,
        templateFile,
        frame,
        {
          contexts: context,
        },
      );
      console.log(documentation);
    } catch (error) {
      console.error(`Error: ${error instanceof Error ? error.message : error}`);
      process.exit(1);
    }
  });

program.parse();

function collectContext(mapping: string, contexts: Record<string, string>) {
  const separator = mapping.lastIndexOf('=');
  if (separator <= 0 || separator === mapping.length - 1) {
    throw new InvalidArgumentError('Expected <url>=<file>.');
  }
  return {
    ...contexts,
    [mapping.slice(0, separator)]: mapping.slice(separator + 1),
  };
}
