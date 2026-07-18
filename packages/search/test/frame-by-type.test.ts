import { describe, expect, it } from 'vitest';
import { Parser } from 'n3';
import { dcat, dcterms, foaf, rdf } from '@tpluscode/rdf-ns-builders';
import {
  buildSubjectIndex,
  frameSubjects,
  type FramedNode,
} from '../src/frame-by-type.js';

const DATASET = dcat.Dataset.value;

function quads(ntriples: string) {
  return new Parser({ format: 'N-Triples' }).parse(ntriples);
}

async function collect(
  iterable: AsyncIterable<FramedNode>,
): Promise<FramedNode[]> {
  const out: FramedNode[] = [];
  for await (const item of iterable) {
    out.push(item);
  }
  return out;
}

/** Build a subject index over `ntriples` and frame the given `roots`. */
function frame(ntriples: string, roots: string[]): AsyncIterable<FramedNode> {
  return frameSubjects(buildSubjectIndex(quads(ntriples)), roots);
}

describe('frameSubjects', () => {
  it('frames each given root’s one-hop subgraph into an IR node', async () => {
    // The roots are supplied by the caller (the pipeline selector); no rdf:type
    // triple is needed to discover them.
    const nodes = await collect(
      frame(
        `
          <https://ex/d/1> <${dcterms.title.value}> "Titel"@nl .
          <https://ex/d/1> <${dcterms.publisher.value}> <https://ex/o/1> .
          <https://ex/o/1> <${foaf.name.value}> "Org"@nl .
          <https://ex/d/2> <${dcterms.title.value}> "Andere"@nl .
        `,
        ['https://ex/d/1', 'https://ex/d/2'],
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
      frame(
        `
          <https://ex/d/1> <${dcat.distribution.value}> _:dist .
          _:dist <${dcterms.title.value}> "Distributie"@nl .
        `,
        ['https://ex/d/1'],
      ),
    );

    expect(nodes).toHaveLength(1);
    expect(nodes[0][dcat.distribution.value]).toMatchObject({
      [dcterms.title.value]: { '@language': 'nl', '@value': 'Distributie' },
    });
  });

  it('keeps a root that references another framed root', async () => {
    // A one-hop reference can itself be a requested root (e.g. a terminology
    // source that is also a separately registered dataset). The referencing
    // subject must still be framed – and the referenced one must not be emitted
    // twice – even though `frame()` embeds the referent inline as well.
    const nodes = await collect(
      frame(
        `
          <https://ex/d/1> <${dcterms.title.value}> "Verwijzer"@nl .
          <https://ex/d/1> <${dcterms.source.value}> <https://ex/d/2> .
          <https://ex/d/2> <${dcterms.title.value}> "Bron"@nl .
        `,
        ['https://ex/d/1', 'https://ex/d/2'],
      ),
    );

    expect(nodes.map((node) => node['@id']).sort()).toEqual([
      'https://ex/d/1',
      'https://ex/d/2',
    ]);
    const byId = Object.fromEntries(nodes.map((node) => [node['@id'], node]));
    expect(byId['https://ex/d/1'][dcterms.source.value]).toMatchObject({
      '@id': 'https://ex/d/2',
    });
  });

  it('dedupes triples a CONSTRUCT may emit more than once', async () => {
    const nodes = await collect(
      frame(
        `
          <https://ex/d/1> <${rdf.type.value}> <${DATASET}> .
          <https://ex/d/1> <${rdf.type.value}> <${DATASET}> .
          <https://ex/d/1> <${dcterms.title.value}> "Titel"@nl .
          <https://ex/d/1> <${dcterms.title.value}> "Titel"@nl .
        `,
        ['https://ex/d/1'],
      ),
    );

    expect(nodes).toHaveLength(1);
    expect(nodes[0][dcterms.title.value]).toEqual({
      '@language': 'nl',
      '@value': 'Titel',
    });
  });

  it('scans a one-shot iterable once, framing every given root off one index', async () => {
    const source = quads(`
      <https://ex/d/1> <${dcterms.title.value}> "Titel"@nl .
      <https://ex/x/1> <${dcterms.title.value}> "Ander"@nl .
    `);
    function* once(): Generator<(typeof source)[number]> {
      yield* source;
    }

    // A generator is exhausted after one pass; framing both roots off the single
    // index proves the one-shot source is scanned exactly once.
    const index = buildSubjectIndex(once());
    const first = await collect(frameSubjects(index, ['https://ex/d/1']));
    const second = await collect(frameSubjects(index, ['https://ex/x/1']));

    expect(first.map((node) => node['@id'])).toEqual(['https://ex/d/1']);
    expect(second.map((node) => node['@id'])).toEqual(['https://ex/x/1']);
  });

  it('frames each explicitly given root, ignoring rdf:type', async () => {
    // No type triples at all: the roots are supplied directly, the way a
    // pipeline selector supplies them.
    const framed = await collect(
      frame(
        `
          <https://ex/d/1> <${dcterms.title.value}> "Een"@nl .
          <https://ex/d/2> <${dcterms.title.value}> "Twee"@nl .
        `,
        ['https://ex/d/1'],
      ),
    );
    expect(framed.map((node) => node['@id'])).toEqual(['https://ex/d/1']);
  });

  it('frames nothing for a root absent from the index', async () => {
    expect(
      await collect(
        frame(`<https://ex/d/1> <${rdf.type.value}> <${DATASET}> .`, [
          'urn:unregistered',
        ]),
      ),
    ).toEqual([]);
  });
});
