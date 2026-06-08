import {
  namespaceNormalizationTransform,
  namespaceNormalizationPlugin,
} from '../../src/index.js';
import { Dataset } from '@lde/dataset';
import { describe, it, expect } from 'vitest';
import { DataFactory } from 'n3';
import type { Quad } from '@rdfjs/types';

const { namedNode, quad } = DataFactory;

const VOID = 'http://rdfs.org/ns/void#';

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

  it('rewrites void:class objects matching the source namespace', async () => {
    const input = quad(
      namedNode(dataset.iri.toString()),
      namedNode(`${VOID}class`),
      namedNode('http://example.org/Person'),
    );

    const quads = await collect(transform(quadStream([input]), { dataset }));

    expect(quads).toHaveLength(1);
    expect(quads[0].object.value).toBe('https://example.org/Person');
  });

  it('rewrites void:property objects matching the source namespace', async () => {
    const input = quad(
      namedNode(dataset.iri.toString()),
      namedNode(`${VOID}property`),
      namedNode('http://example.org/name'),
    );

    const quads = await collect(transform(quadStream([input]), { dataset }));

    expect(quads).toHaveLength(1);
    expect(quads[0].object.value).toBe('https://example.org/name');
  });

  it('does not rewrite void:vocabulary', async () => {
    const input = quad(
      namedNode(dataset.iri.toString()),
      namedNode(`${VOID}vocabulary`),
      namedNode('http://example.org/'),
    );

    const quads = await collect(transform(quadStream([input]), { dataset }));

    expect(quads).toHaveLength(1);
    expect(quads[0].object.value).toBe('http://example.org/');
  });

  it('does not rewrite non-matching URIs', async () => {
    const input = quad(
      namedNode(dataset.iri.toString()),
      namedNode(`${VOID}class`),
      namedNode('http://xmlns.com/foaf/0.1/Person'),
    );

    const quads = await collect(transform(quadStream([input]), { dataset }));

    expect(quads).toHaveLength(1);
    expect(quads[0].object.value).toBe('http://xmlns.com/foaf/0.1/Person');
  });

  it('does not rewrite URIs already using the target namespace', async () => {
    const input = quad(
      namedNode(dataset.iri.toString()),
      namedNode(`${VOID}class`),
      namedNode('https://example.org/Person'),
    );

    const quads = await collect(transform(quadStream([input]), { dataset }));

    expect(quads).toHaveLength(1);
    expect(quads[0].object.value).toBe('https://example.org/Person');
  });

  it('preserves subject and graph when rewriting', async () => {
    const graphNode = namedNode('http://example.com/graph');
    const input = quad(
      namedNode(dataset.iri.toString()),
      namedNode(`${VOID}class`),
      namedNode('http://example.org/Event'),
      graphNode,
    );

    const quads = await collect(transform(quadStream([input]), { dataset }));

    expect(quads[0].subject.value).toBe(dataset.iri.toString());
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
