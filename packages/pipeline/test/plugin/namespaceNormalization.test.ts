import {
  namespaceNormalizationTransform,
  namespaceNormalizationPlugin,
} from '../../src/index.js';
import { Dataset } from '@lde/dataset';
import { describe, it, expect } from 'vitest';
import { DataFactory } from 'n3';
import type { Quad } from '@rdfjs/types';

const { namedNode, literal, blankNode, quad } = DataFactory;

const dataset = new Dataset({
  iri: new URL('http://example.com/dataset/1'),
  distributions: [],
});

const options = { from: 'http://example.org/', to: 'https://example.org/' };

async function collect(iter: AsyncIterable<Quad>): Promise<Quad[]> {
  const result: Quad[] = [];
  for await (const q of iter) {
    result.push(q);
  }
  return result;
}

function quadStream(quads: Quad[]): AsyncIterable<Quad> {
  return (async function* () {
    yield* quads;
  })();
}

describe('namespaceNormalizationTransform', () => {
  const transform = namespaceNormalizationTransform(options);

  it('rewrites an object IRI matching the source namespace', async () => {
    const input = quad(
      namedNode('http://example.com/thing'),
      namedNode('http://www.w3.org/1999/02/22-rdf-syntax-ns#type'),
      namedNode('http://example.org/Person'),
    );

    const quads = await collect(
      transform(quadStream([input]), { dataset, stage: 'test' }),
    );

    expect(quads).toHaveLength(1);
    expect(quads[0].object.value).toBe('https://example.org/Person');
  });

  it('rewrites a predicate IRI matching the source namespace', async () => {
    const input = quad(
      namedNode('http://example.com/thing'),
      namedNode('http://example.org/name'),
      literal('Ada'),
    );

    const quads = await collect(
      transform(quadStream([input]), { dataset, stage: 'test' }),
    );

    expect(quads).toHaveLength(1);
    expect(quads[0].predicate.value).toBe('https://example.org/name');
    expect(quads[0].object.value).toBe('Ada');
  });

  it('rewrites a subject IRI matching the source namespace', async () => {
    const input = quad(
      namedNode('http://example.org/Person'),
      namedNode('http://www.w3.org/2000/01/rdf-schema#label'),
      literal('Person'),
    );

    const quads = await collect(
      transform(quadStream([input]), { dataset, stage: 'test' }),
    );

    expect(quads).toHaveLength(1);
    expect(quads[0].subject.value).toBe('https://example.org/Person');
  });

  it('does not rewrite IRIs outside the source namespace', async () => {
    const input = quad(
      namedNode('http://example.com/thing'),
      namedNode('http://www.w3.org/1999/02/22-rdf-syntax-ns#type'),
      namedNode('http://xmlns.com/foaf/0.1/Person'),
    );

    const quads = await collect(
      transform(quadStream([input]), { dataset, stage: 'test' }),
    );

    expect(quads[0].object.value).toBe('http://xmlns.com/foaf/0.1/Person');
  });

  it('does not rewrite IRIs already using the target namespace', async () => {
    const input = quad(
      namedNode('http://example.com/thing'),
      namedNode('http://www.w3.org/1999/02/22-rdf-syntax-ns#type'),
      namedNode('https://example.org/Person'),
    );

    const quads = await collect(
      transform(quadStream([input]), { dataset, stage: 'test' }),
    );

    expect(quads[0].object.value).toBe('https://example.org/Person');
  });

  it('leaves literal and blank-node terms untouched', async () => {
    const input = quad(
      blankNode('b0'),
      namedNode('http://example.org/note'),
      literal('http://example.org/Person'),
    );

    const quads = await collect(
      transform(quadStream([input]), { dataset, stage: 'test' }),
    );

    expect(quads[0].subject.termType).toBe('BlankNode');
    expect(quads[0].object.termType).toBe('Literal');
    // A literal that merely contains the namespace text is not an IRI, so it is
    // left as-is; only the predicate IRI is rewritten.
    expect(quads[0].object.value).toBe('http://example.org/Person');
    expect(quads[0].predicate.value).toBe('https://example.org/note');
  });

  it('preserves the graph when rewriting', async () => {
    const graphNode = namedNode('http://example.com/graph');
    const input = quad(
      namedNode('http://example.com/thing'),
      namedNode('http://www.w3.org/1999/02/22-rdf-syntax-ns#type'),
      namedNode('http://example.org/Event'),
      graphNode,
    );

    const quads = await collect(
      transform(quadStream([input]), { dataset, stage: 'test' }),
    );

    expect(quads[0].object.value).toBe('https://example.org/Event');
    expect(quads[0].graph.value).toBe('http://example.com/graph');
  });
});

describe('namespaceNormalizationPlugin', () => {
  it('returns a plugin with the correct name', () => {
    const plugin = namespaceNormalizationPlugin(options);
    expect(plugin.name).toBe('namespace-normalization');
  });

  it('has a beforeStageWrite hook', () => {
    const plugin = namespaceNormalizationPlugin(options);
    expect(plugin.beforeStageWrite).toBeTypeOf('function');
  });
});
