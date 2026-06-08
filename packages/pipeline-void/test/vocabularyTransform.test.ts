import { withVocabularies } from '../src/index.js';
import { Dataset, Distribution } from '@lde/dataset';
import type { ExecutorContext } from '@lde/pipeline';
import { describe, it, expect } from 'vitest';
import { DataFactory } from 'n3';
import type { Quad } from '@rdfjs/types';

const { namedNode, quad } = DataFactory;

const VOID = 'http://rdfs.org/ns/void#';

const dataset = new Dataset({
  iri: new URL('http://example.com/dataset/1'),
  distributions: [],
});
const distribution = new Distribution(new URL('http://example.com/sparql'));

const context: ExecutorContext = {
  dataset,
  distribution,
  stage: 'entity-properties.rq',
};

function quadStream(quads: Quad[]): AsyncIterable<Quad> {
  return (async function* () {
    yield* quads;
  })();
}

async function collect(stream: AsyncIterable<Quad>): Promise<Quad[]> {
  const result: Quad[] = [];
  for await (const q of stream) {
    result.push(q);
  }
  return result;
}

describe('withVocabularies', () => {
  const transform = withVocabularies();

  it('passes through all input quads', async () => {
    const input = quad(
      namedNode(dataset.iri.toString()),
      namedNode(`${VOID}triples`),
      namedNode('http://example.com/100'),
    );

    const quads = await collect(transform(quadStream([input]), context));
    expect(quads[0]).toBe(input);
  });

  it('adds void:vocabulary for schema.org properties', async () => {
    const input = quad(
      namedNode(dataset.iri.toString()),
      namedNode(`${VOID}property`),
      namedNode('http://schema.org/name'),
    );

    const quads = await collect(transform(quadStream([input]), context));
    const vocabQuads = quads.filter(
      (q) => q.predicate.value === `${VOID}vocabulary`,
    );
    expect(vocabQuads).toHaveLength(1);
    expect(vocabQuads[0].subject.value).toBe(dataset.iri.toString());
    expect(vocabQuads[0].object.value).toBe('http://schema.org/');
  });

  it('adds void:vocabulary for Dublin Core properties', async () => {
    const input = [
      quad(
        namedNode(dataset.iri.toString()),
        namedNode(`${VOID}property`),
        namedNode('http://purl.org/dc/terms/title'),
      ),
      quad(
        namedNode(dataset.iri.toString()),
        namedNode(`${VOID}property`),
        namedNode('http://purl.org/dc/elements/1.1/creator'),
      ),
    ];

    const quads = await collect(transform(quadStream(input), context));
    const vocabQuads = quads.filter(
      (q) => q.predicate.value === `${VOID}vocabulary`,
    );
    expect(vocabQuads).toHaveLength(2);
    const vocabUris = vocabQuads.map((q) => q.object.value).sort();
    expect(vocabUris).toEqual([
      'http://purl.org/dc/elements/1.1/',
      'http://purl.org/dc/terms/',
    ]);
  });

  it('does not add duplicates for same vocabulary', async () => {
    const input = [
      quad(
        namedNode(dataset.iri.toString()),
        namedNode(`${VOID}property`),
        namedNode('http://schema.org/name'),
      ),
      quad(
        namedNode(dataset.iri.toString()),
        namedNode(`${VOID}property`),
        namedNode('http://schema.org/description'),
      ),
    ];

    const quads = await collect(transform(quadStream(input), context));
    const vocabQuads = quads.filter(
      (q) => q.predicate.value === `${VOID}vocabulary`,
    );
    expect(vocabQuads).toHaveLength(1);
  });

  it('does not add vocabulary for unknown prefixes', async () => {
    const input = quad(
      namedNode(dataset.iri.toString()),
      namedNode(`${VOID}property`),
      namedNode('http://example.com/custom/property'),
    );

    const quads = await collect(transform(quadStream([input]), context));
    const vocabQuads = quads.filter(
      (q) => q.predicate.value === `${VOID}vocabulary`,
    );
    expect(vocabQuads).toHaveLength(0);
  });

  it('uses custom vocabularies when provided', async () => {
    const customTransform = withVocabularies(['http://example.com/vocab/']);
    const input = [
      quad(
        namedNode(dataset.iri.toString()),
        namedNode(`${VOID}property`),
        namedNode('http://example.com/vocab/name'),
      ),
      quad(
        namedNode(dataset.iri.toString()),
        namedNode(`${VOID}property`),
        namedNode('http://schema.org/name'),
      ),
    ];

    const quads = await collect(customTransform(quadStream(input), context));
    const vocabQuads = quads.filter(
      (q) => q.predicate.value === `${VOID}vocabulary`,
    );
    expect(vocabQuads).toHaveLength(1);
    expect(vocabQuads[0].object.value).toBe('http://example.com/vocab/');
  });
});
