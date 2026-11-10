import { describe, expect, it } from 'vitest';
import { join, relative } from 'node:path';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { render } from '../src/render.js';

async function renderTemplate(context: unknown, template: string) {
  const directory = await mkdtemp(join(tmpdir(), 'docgen-render-'));
  const templatePath = join(directory, 'template.liquid');
  await writeFile(templatePath, template);
  return render({ '@context': context, '@graph': [] } as never, templatePath);
}

describe('render', () => {
  it('renders a template in a subfolder, given a path relative to the working directory', async () => {
    // A path such as assets/diagram.mmd.liquid, as a spec’s Makefile passes it.
    const directory = await mkdtemp(join(process.cwd(), 'docgen-render-'));
    try {
      await mkdir(join(directory, 'assets'));
      await writeFile(join(directory, 'assets', 'diagram.liquid'), 'diagram');
      const relativePath = relative(
        process.cwd(),
        join(directory, 'assets', 'diagram.liquid'),
      );

      expect(await render({ '@graph': [] } as never, relativePath)).toBe(
        'diagram',
      );
    } finally {
      await rm(directory, { recursive: true });
    }
  });
});

describe('expandIri', () => {
  it('expands a compact IRI with a prefix from the frame’s context', async () => {
    const output = await renderTemplate(
      {
        schema: 'https://schema.org/',
        dcat: { '@id': 'http://www.w3.org/ns/dcat#' },
      },
      '{{ "schema:name" | expandIri }} {{ "dcat:accessURL" | expandIri }}',
    );

    expect(output).toBe(
      'https://schema.org/name http://www.w3.org/ns/dcat#accessURL',
    );
  });

  it('leaves absolute IRIs, unknown prefixes and non-prefix terms unchanged', async () => {
    const output = await renderTemplate(
      [
        'https://example.org/remote-context.jsonld',
        { path: { '@type': '@id' } },
        { name: 'https://schema.org/name' },
      ],
      [
        '{{ "https://schema.org/name" | expandIri }}',
        '{{ "foaf:page" | expandIri }}',
        '{{ "name:x" | expandIri }}',
        '{{ "plain" | expandIri }}',
        '{{ 1 | expandIri }}',
      ].join(' '),
    );

    expect(output).toBe('https://schema.org/name foaf:page name:x plain 1');
  });

  it('only expands the prefix at the start', async () => {
    const output = await renderTemplate(
      { dct: 'http://purl.org/dc/terms/', ex: 'https://example.org/' },
      '{{ "ex:dct:title" | expandIri }}',
    );

    expect(output).toBe('https://example.org/dct:title');
  });
});

describe('jsonLdToTurtle', () => {
  it('prints a JSON-LD file next to the template as Turtle, with the frame’s prefixes', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'docgen-render-'));
    await mkdir(join(directory, 'examples'));
    await writeFile(
      join(directory, 'examples', 'painting.jsonld'),
      JSON.stringify({
        '@context': 'https://example.org/context',
        '@id': 'https://example.org/painting',
        '@type': 'https://example.org/Painting',
        'http://schema.org/name': 'De Nachtwacht',
        'https://schema.org/sameAs': { '@id': 'https://example.org/other' },
      }),
    );
    await writeFile(
      join(directory, 'context.jsonld'),
      JSON.stringify({ '@context': {} }),
    );
    const templatePath = join(directory, 'template.liquid');
    await writeFile(
      templatePath,
      `{{ 'examples/painting.jsonld' | jsonLdToTurtle }}`,
    );

    const output = await render(
      {
        // The built-in prefixes win over the frame’s: the default frame maps
        // schema to http://schema.org/, and sdo here renames schema.
        '@context': {
          ex: 'https://example.org/',
          schema: 'http://schema.org/',
          sdo: 'https://schema.org/',
        },
        '@graph': [],
      } as never,
      templatePath,
      {
        contexts: {
          'https://example.org/context': join(directory, 'context.jsonld'),
        },
      },
    );

    expect(output).toBe(
      [
        '@prefix ex: <https://example.org/>.',
        '@prefix schema: <https://schema.org/>.',
        '',
        'ex:painting a ex:Painting;',
        '  <http://schema.org/name> "De Nachtwacht";',
        '  schema:sameAs ex:other.',
        '',
      ].join('\n'),
    );
  });
});
