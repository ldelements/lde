import { afterEach, describe, expect, it, vi } from 'vitest';
import { join } from 'node:path';
import { JsonLdToTurtle } from '../src/turtle.js';

const vocabularyContext = { '@context': { '@vocab': 'https://schema.org/' } };

// A Response knows its URL only when fetch() created it. A body of bytes, unlike
// a string, leaves the content type to the headers.
function responseFrom(
  url: string,
  body: string,
  headers: Record<string, string>,
) {
  const response = new Response(new TextEncoder().encode(body), { headers });
  Object.defineProperty(response, 'url', { value: url });
  return response;
}

const fixtures = join(import.meta.dirname, 'fixtures', 'turtle');
const contexts = {
  'https://example.org/context': join(fixtures, 'context.jsonld'),
};

describe('JsonLdToTurtle', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('prints the triples with a local context, prefixes and nested blank nodes', async () => {
    const turtle = await new JsonLdToTurtle({ contexts }).convert(
      join(fixtures, 'painting.jsonld'),
    );

    expect(turtle).toBe(
      [
        '@prefix schema: <https://schema.org/>.',
        '@prefix xsd: <http://www.w3.org/2001/XMLSchema#>.',
        '',
        '<https://example.org/painting> a schema:Painting;',
        '  schema:creator [ a schema:Person;',
        '      schema:sameAs <https://example.org/rembrandt>',
        '    ];',
        '  schema:dateCreated "1642"^^xsd:gYear;',
        '  schema:name "De Nachtwacht"@nl.',
        '',
      ].join('\n'),
    );
  });

  it('matches a context URL with or without a trailing slash', async () => {
    const converter = new JsonLdToTurtle({
      contexts: {
        'https://example.org/context/': contexts['https://example.org/context'],
      },
    });

    // painting.jsonld cites the context with a slash, named-graph.jsonld without.
    await expect(
      converter.convert(join(fixtures, 'painting.jsonld')),
    ).resolves.toContain('schema:Painting');
    await expect(
      converter.convert(join(fixtures, 'named-graph.jsonld')),
    ).rejects.toThrow('named graphs');
  });

  it('uses the prefixes it is given', async () => {
    const turtle = await new JsonLdToTurtle({
      contexts,
      prefixes: new Map([['sdo', 'https://schema.org/']]),
    }).convert(join(fixtures, 'painting.jsonld'));

    expect(turtle).toContain('a sdo:Painting');
    expect(turtle).toContain(
      '"1642"^^<http://www.w3.org/2001/XMLSchema#gYear>',
    );
  });

  it('fetches a context that it has no file for, once', async () => {
    const fetch = vi.fn(async (url: string) =>
      responseFrom(url, JSON.stringify(vocabularyContext), {
        'content-type': 'application/ld+json',
      }),
    );
    vi.stubGlobal('fetch', fetch);
    const converter = new JsonLdToTurtle();

    await converter.convert(join(fixtures, 'remote-context.jsonld'));
    const turtle = await converter.convert(
      join(fixtures, 'remote-context.jsonld'),
    );

    expect(turtle).toContain('schema:name "De Nachtwacht"');
    expect(fetch).toHaveBeenCalledOnce();
    expect(fetch).toHaveBeenCalledWith('https://example.org/remote', {
      headers: { accept: 'application/ld+json, application/json' },
    });
  });

  it('follows a Link header to an alternate JSON-LD context, as schema.org has', async () => {
    const fetch = vi.fn(async (url: string) =>
      url === 'https://example.org/remote'
        ? responseFrom(url, '<html></html>', {
            'content-type': 'text/html',
            link: '<https://example.org/other>; rel="preload", </context.jsonld>; type="application/ld+json"; rel="alternate"',
          })
        : responseFrom(url, JSON.stringify(vocabularyContext), {}),
    );
    vi.stubGlobal('fetch', fetch);

    const turtle = await new JsonLdToTurtle().convert(
      join(fixtures, 'remote-context.jsonld'),
    );

    expect(turtle).toContain('schema:name "De Nachtwacht"');
    expect(fetch).toHaveBeenLastCalledWith(
      'https://example.org/context.jsonld',
      expect.anything(),
    );
  });

  it('reads a response without a JSON-LD alternate as JSON', async () => {
    vi.stubGlobal('fetch', async (url: string) =>
      responseFrom(url, '<html></html>', {
        link: '<https://example.org/other>; rel="alternate"; type="text/turtle"',
      }),
    );

    await expect(
      new JsonLdToTurtle().convert(join(fixtures, 'remote-context.jsonld')),
    ).rejects.toThrow(/JSON/);
  });

  it('fetches a context again after a failure', async () => {
    const fetch = vi
      .fn()
      .mockRejectedValueOnce(new Error('offline'))
      .mockImplementation(async (url: string) =>
        responseFrom(url, JSON.stringify(vocabularyContext), {}),
      );
    vi.stubGlobal('fetch', fetch);
    const converter = new JsonLdToTurtle();

    await expect(
      converter.convert(join(fixtures, 'remote-context.jsonld')),
    ).rejects.toThrow('to Turtle: offline');
    await expect(
      converter.convert(join(fixtures, 'remote-context.jsonld')),
    ).resolves.toContain('schema:name');
  });

  it('reports a rejection that is not an Error', async () => {
    vi.stubGlobal('fetch', () => Promise.reject('offline'));

    await expect(
      new JsonLdToTurtle().convert(join(fixtures, 'remote-context.jsonld')),
    ).rejects.toThrow('to Turtle: offline');
  });

  it('writes an IRI in full rather than as an invalid prefixed name', async () => {
    const turtle = await new JsonLdToTurtle({
      prefixes: new Map([
        ['ex', 'https://example.org/'],
        ['schema', 'https://schema.org/'],
      ]),
    }).convert(join(fixtures, 'iri-paths.jsonld'));

    expect(turtle).not.toContain('@prefix ex:');
    expect(turtle).toContain('<https://example.org/id/painting/1>');
    expect(turtle).toContain('<https://example.org/end.>');
    expect(turtle).toContain('schema:sameAs');
  });

  it('fails when a context cannot be fetched', async () => {
    vi.stubGlobal(
      'fetch',
      async () => new Response('Not found', { status: 404 }),
    );

    await expect(
      new JsonLdToTurtle().convert(join(fixtures, 'remote-context.jsonld')),
    ).rejects.toThrow(
      'remote-context.jsonld to Turtle: https://example.org/remote responded with HTTP status 404',
    );
  });

  it.each([
    [
      'a term without a mapping',
      'unmapped-term.jsonld',
      'Dropping property',
      '"title"',
    ],
    [
      'a relative IRI',
      'relative-iri.jsonld',
      'Relative @id reference',
      '"painting"',
    ],
  ])('fails rather than drop %s', async (_case, file, reason, value) => {
    const conversion = new JsonLdToTurtle().convert(join(fixtures, file));

    await expect(conversion).rejects.toThrow(
      `Cannot convert ${join(fixtures, file)} to Turtle: ${reason}`,
    );
    await expect(conversion).rejects.toThrow(value);
  });

  it('fails on a file that is not JSON', async () => {
    await expect(
      new JsonLdToTurtle().convert(join(fixtures, 'malformed.jsonld')),
    ).rejects.toThrow(/malformed\.jsonld to Turtle: .*JSON/);
  });

  it('fails on a named graph', async () => {
    await expect(
      new JsonLdToTurtle({ contexts }).convert(
        join(fixtures, 'named-graph.jsonld'),
      ),
    ).rejects.toThrow(
      'named graphs, such as https://example.org/graph, are not supported',
    );
  });
});
