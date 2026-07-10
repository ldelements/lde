import { describe, expect, it } from 'vitest';
import { Parser } from 'n3';
import { dcat, dcterms, foaf, rdf } from '@tpluscode/rdf-ns-builders';
import {
  buildSubjectIndex,
  frameByType,
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

  it('keeps a root subject that references another root-typed subject', async () => {
    // A one-hop reference can itself be of the root type (e.g. a terminology
    // source that is also a separately registered dataset). The referencing
    // subject must still be projected — and the referenced one must not be
    // emitted twice — even though both match the frame’s `@type`.
    const nodes = await collect(
      frameByType(
        quads(`
          <https://ex/d/1> <${rdf.type.value}> <${DATASET}> .
          <https://ex/d/1> <${dcterms.title.value}> "Verwijzer"@nl .
          <https://ex/d/1> <${dcterms.source.value}> <https://ex/d/2> .
          <https://ex/d/2> <${rdf.type.value}> <${DATASET}> .
          <https://ex/d/2> <${dcterms.title.value}> "Bron"@nl .
        `),
        DATASET,
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

describe('buildSubjectIndex / frameSubjects', () => {
  it('scans a one-shot iterable once, indexing every requested root type', async () => {
    const other = 'http://example.org/Other';
    const source = quads(`
      <https://ex/d/1> <${rdf.type.value}> <${DATASET}> .
      <https://ex/d/1> <${dcterms.title.value}> "Titel"@nl .
      <https://ex/x/1> <${rdf.type.value}> <${other}> .
      <https://ex/x/1> <${dcterms.title.value}> "Ander"@nl .
    `);
    function* once(): Generator<(typeof source)[number]> {
      yield* source;
    }

    // A single pass over the generator must still index both types.
    const index = buildSubjectIndex(once(), [DATASET, other]);
    const datasets = await collect(frameSubjects(index, DATASET));
    const others = await collect(frameSubjects(index, other));

    expect(datasets.map((node) => node['@id'])).toEqual(['https://ex/d/1']);
    expect(others.map((node) => node['@id'])).toEqual(['https://ex/x/1']);
  });

  it('frames nothing for a type the index was not built for', async () => {
    const index = buildSubjectIndex(
      quads(`<https://ex/d/1> <${rdf.type.value}> <${DATASET}> .`),
      [DATASET],
    );
    expect(await collect(frameSubjects(index, 'urn:unregistered'))).toEqual([]);
  });
});
