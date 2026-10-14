import { describe, expect, it } from 'vitest';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { frame } from '../src/frame.js';
import { parseRdfToJsonLd } from '../src/parse.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SHACL_PATH = join(__dirname, 'fixtures', 'shacl.ttl');
const MULTIPLE_OR_PATH = join(__dirname, 'fixtures', 'multiple-or.ttl');
const PARTIAL_FRAME_PATH = join(__dirname, 'fixtures', 'partial.frame.jsonld');

describe('frame', () => {
  it('uses the built-in default frame when no user frame is given', async () => {
    const document = await parseRdfToJsonLd(SHACL_PATH);
    const framed = (await frame(document)) as { '@graph': unknown[] };

    expect(framed['@graph']).toBeDefined();
    expect(Array.isArray(framed['@graph'])).toBe(true);
    expect(framed['@graph'].length).toBeGreaterThan(0);
  });

  it('deep-merges a user-supplied frame with the default', async () => {
    const document = await parseRdfToJsonLd(SHACL_PATH);
    const framed = (await frame(document, PARTIAL_FRAME_PATH)) as {
      '@context': Record<string, unknown>;
      '@graph': unknown[];
    };

    // User addition is present.
    expect(framed['@context'].schema).toBe('https://schema.org/');

    // Default coercions are still applied (path is rendered as IRI string,
    // not a `{ "@id": "..." }` object), proving the default frame’s
    // `"path": { "@type": "@id" }` was preserved.
    const firstShape = framed['@graph'][0] as { property: { path: unknown }[] };
    expect(typeof firstShape.property[0].path).toBe('string');
  });

  it('keeps every sh:or list on a shape as an array of alternatives', async () => {
    const document = await parseRdfToJsonLd(MULTIPLE_OR_PATH);
    const framed = (await frame(document)) as { '@graph': { or: unknown }[] };

    const alternative = (path: string) => ({
      property: { minCount: 1, path: `https://example.org/${path}` },
    });
    expect(framed['@graph'][0].or).toEqual(
      expect.arrayContaining([
        [alternative('accessURL'), alternative('downloadURL')],
        [alternative('mediaType'), alternative('format')],
      ]),
    );
    expect(framed['@graph'][0].or).toHaveLength(2);
  });

  it('wraps a single sh:or list in an array too', async () => {
    const document = await parseRdfToJsonLd(SHACL_PATH);
    const framed = (await frame(document)) as {
      '@graph': { property: { path: string; or?: unknown }[] }[];
    };

    const description = framed['@graph'][0].property.find(
      (property) => property.or !== undefined,
    );
    expect(description?.or).toEqual([
      [{ datatype: 'rdf:langString' }, { datatype: 'xsd:string' }],
    ]);
  });

  it('lets a user frame override a default coercion', async () => {
    const overridePath = join(
      tmpdir(),
      `docgen-frame-override-${Date.now()}.jsonld`,
    );
    await writeFile(
      overridePath,
      JSON.stringify({
        '@context': {
          severity: { '@type': '@id' },
        },
      }),
    );

    const document = await parseRdfToJsonLd(SHACL_PATH);
    const framed = (await frame(document, overridePath)) as {
      '@graph': { property: { severity?: unknown }[] }[];
    };

    const properties = framed['@graph'].flatMap((shape) => shape.property);
    const withSeverity = properties.find((p) => p.severity !== undefined);

    // Default coerces severity to @vocab → "Info"; the override coerces to
    // @id → full IRI "http://www.w3.org/ns/shacl#Info".
    expect(withSeverity?.severity).toBe('http://www.w3.org/ns/shacl#Info');
  });
});
