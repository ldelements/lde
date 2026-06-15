import { describe, expect, it } from 'vitest';
import { Parser } from 'n3';
import { frameByType, type FramedSubject } from '../src/frame-by-type.js';

const RDF = 'http://www.w3.org/1999/02/22-rdf-syntax-ns#';
const DCAT = 'http://www.w3.org/ns/dcat#';
const DCT = 'http://purl.org/dc/terms/';
const FOAF = 'http://xmlns.com/foaf/0.1/';
const DATASET = `${DCAT}Dataset`;

function quads(ntriples: string) {
  return new Parser({ format: 'N-Triples' }).parse(ntriples);
}

async function collect(
  iterable: AsyncIterable<FramedSubject>,
): Promise<FramedSubject[]> {
  const out: FramedSubject[] = [];
  for await (const item of iterable) {
    out.push(item);
  }
  return out;
}

describe('frameByType', () => {
  it('frames each root subject’s one-hop subgraph into an IR node', async () => {
    const nodes = await collect(
      frameByType(
        quads(`
          <https://ex/d/1> <${RDF}type> <${DATASET}> .
          <https://ex/d/1> <${DCT}title> "Titel"@nl .
          <https://ex/d/1> <${DCT}publisher> <https://ex/o/1> .
          <https://ex/o/1> <${FOAF}name> "Org"@nl .
          <https://ex/d/2> <${RDF}type> <${DATASET}> .
          <https://ex/d/2> <${DCT}title> "Andere"@nl .
        `),
        DATASET,
      ),
    );

    expect(nodes).toHaveLength(2);
    const byId = Object.fromEntries(nodes.map((node) => [node['@id'], node]));
    // The one-hop publisher node is embedded with its name.
    expect(byId['https://ex/d/1'][`${DCT}publisher`]).toMatchObject({
      '@id': 'https://ex/o/1',
      [`${FOAF}name`]: { '@language': 'nl', '@value': 'Org' },
    });
    expect(byId['https://ex/d/2'][`${DCT}title`]).toEqual({
      '@language': 'nl',
      '@value': 'Andere',
    });
  });

  it('dedupes triples a CONSTRUCT may emit more than once', async () => {
    const nodes = await collect(
      frameByType(
        quads(`
          <https://ex/d/1> <${RDF}type> <${DATASET}> .
          <https://ex/d/1> <${RDF}type> <${DATASET}> .
          <https://ex/d/1> <${DCT}title> "Titel"@nl .
          <https://ex/d/1> <${DCT}title> "Titel"@nl .
        `),
        DATASET,
      ),
    );

    expect(nodes).toHaveLength(1);
    expect(nodes[0]![`${DCT}title`]).toEqual({
      '@language': 'nl',
      '@value': 'Titel',
    });
  });

  it('yields nothing when there are no subjects of the root type', async () => {
    const nodes = await collect(
      frameByType(quads(`<https://ex/o/1> <${FOAF}name> "Org"@nl .`), DATASET),
    );
    expect(nodes).toEqual([]);
  });
});
