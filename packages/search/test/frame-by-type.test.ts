import { describe, expect, it } from 'vitest';
import { Parser } from 'n3';
import { dcat, dcterms, foaf, rdf } from '@tpluscode/rdf-ns-builders';
import { frameByType, type FramedSubject } from '../src/frame-by-type.js';

const DATASET = dcat.Dataset.value;

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
          <https://ex/d/1> <${rdf.type.value}> <${DATASET}> .
          <https://ex/d/1> <${dcterms.title.value}> "Titel"@nl .
          <https://ex/d/1> <${dcterms.publisher.value}> <https://ex/o/1> .
          <https://ex/o/1> <${foaf.name.value}> "Org"@nl .
          <https://ex/d/2> <${rdf.type.value}> <${DATASET}> .
          <https://ex/d/2> <${dcterms.title.value}> "Andere"@nl .
        `),
        DATASET,
      ),
    );

    expect(nodes).toHaveLength(2);
    const byId = Object.fromEntries(nodes.map((node) => [node['@id'], node]));
    // The one-hop publisher node is embedded with its name.
    expect(byId['https://ex/d/1'][dcterms.publisher.value]).toMatchObject({
      '@id': 'https://ex/o/1',
      [foaf.name.value]: { '@language': 'nl', '@value': 'Org' },
    });
    expect(byId['https://ex/d/2'][dcterms.title.value]).toEqual({
      '@language': 'nl',
      '@value': 'Andere',
    });
  });

  it('embeds one-hop blank-node references', async () => {
    const nodes = await collect(
      frameByType(
        quads(`
          <https://ex/d/1> <${rdf.type.value}> <${DATASET}> .
          <https://ex/d/1> <${dcat.distribution.value}> _:dist .
          _:dist <${dcterms.title.value}> "Distributie"@nl .
        `),
        DATASET,
      ),
    );

    expect(nodes).toHaveLength(1);
    expect(nodes[0]![dcat.distribution.value]).toMatchObject({
      [dcterms.title.value]: { '@language': 'nl', '@value': 'Distributie' },
    });
  });

  it('dedupes triples a CONSTRUCT may emit more than once', async () => {
    const nodes = await collect(
      frameByType(
        quads(`
          <https://ex/d/1> <${rdf.type.value}> <${DATASET}> .
          <https://ex/d/1> <${rdf.type.value}> <${DATASET}> .
          <https://ex/d/1> <${dcterms.title.value}> "Titel"@nl .
          <https://ex/d/1> <${dcterms.title.value}> "Titel"@nl .
        `),
        DATASET,
      ),
    );

    expect(nodes).toHaveLength(1);
    expect(nodes[0]![dcterms.title.value]).toEqual({
      '@language': 'nl',
      '@value': 'Titel',
    });
  });

  it('yields nothing when there are no subjects of the root type', async () => {
    const nodes = await collect(
      frameByType(
        quads(`<https://ex/o/1> <${foaf.name.value}> "Org"@nl .`),
        DATASET,
      ),
    );
    expect(nodes).toEqual([]);
  });
});
