import { describe, it, expect } from 'vitest';
import { parseRdfToJsonLd } from '../src/parse.js';
import { resolve } from 'path';

describe('parseRdfToJsonLd', () => {
  it('should parse SHACL Turtle file to JSON-LD string', async () => {
    const filePath = resolve('./test/fixtures/shacl.ttl');
    const shapes = await parseRdfToJsonLd(filePath);
    expect(shapes.length).toBe(12);
  });

  it('keeps blank nodes in the order of the source file', async () => {
    const filePath = resolve('./test/fixtures/order.ttl');
    const shapes = await parseRdfToJsonLd(filePath);
    const names = shapes
      .filter((shape) => shape['http://www.w3.org/ns/shacl#name'])
      .map(
        (shape) =>
          (
            shape['http://www.w3.org/ns/shacl#name'] as { '@value': string }[]
          )[0]['@value'],
      );
    expect(names).toEqual([
      'First',
      'Second',
      'Third',
      'Fourth',
      'Fifth',
      'Sixth',
      'Seventh',
      'Eighth',
      'Ninth',
      'Tenth',
      'Eleventh',
      'Twelfth',
    ]);
  });
});
