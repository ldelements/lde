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

describe('partials', () => {
  // A spec folder with its own partial and a shared folder next to it, under the
  // working directory so the shared folder can also be given as a relative path.
  async function specWithSharedPartials() {
    const directory = await mkdtemp(join(process.cwd(), 'docgen-render-'));
    await mkdir(join(directory, 'spec'));
    await mkdir(join(directory, 'shared'));
    await writeFile(
      join(directory, 'spec', 'template.liquid'),
      "{% render 'shared' %} {% render 'both' %}",
    );
    await writeFile(join(directory, 'spec', 'both.liquid'), 'own');
    await writeFile(join(directory, 'shared', 'shared.liquid'), 'shared');
    await writeFile(join(directory, 'shared', 'both.liquid'), 'not own');
    return directory;
  }

  it('renders a partial from the partials folder, and prefers the template’s own', async () => {
    const directory = await specWithSharedPartials();
    try {
      expect(
        await render(
          { '@graph': [] } as never,
          join(directory, 'spec', 'template.liquid'),
          join(directory, 'shared'),
        ),
      ).toBe('shared own');
    } finally {
      await rm(directory, { recursive: true });
    }
  });

  it('resolves a relative partials folder against the working directory', async () => {
    const directory = await specWithSharedPartials();
    try {
      expect(
        await render(
          { '@graph': [] } as never,
          relative(process.cwd(), join(directory, 'spec', 'template.liquid')),
          relative(process.cwd(), join(directory, 'shared')),
        ),
      ).toBe('shared own');
    } finally {
      await rm(directory, { recursive: true });
    }
  });

  it('fails on a partials folder that does not exist', async () => {
    const directory = await specWithSharedPartials();
    try {
      for (const partialsPath of [join(directory, 'missing'), '']) {
        await expect(
          render(
            { '@graph': [] } as never,
            join(directory, 'spec', 'template.liquid'),
            partialsPath,
          ),
        ).rejects.toThrow('Partials folder not found');
      }
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
