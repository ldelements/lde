import { describe, expect, it } from 'vitest';
import { join } from 'node:path';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { render } from '../src/render.js';

async function renderTemplate(context: unknown, template: string) {
  const directory = await mkdtemp(join(tmpdir(), 'docgen-render-'));
  const templatePath = join(directory, 'template.liquid');
  await writeFile(templatePath, template);
  return render({ '@context': context, '@graph': [] } as never, templatePath);
}

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
