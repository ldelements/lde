import {
  schemaOrgNormalizationTransform,
  schemaOrgNormalizationPlugin,
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

describe('schemaOrgNormalizationTransform', () => {
  it('rewrites void:class from http to https schema.org', async () => {
    const input = quad(
      namedNode(dataset.iri.toString()),
      namedNode(`${VOID}class`),
      namedNode('http://schema.org/Person'),
    );

    const quads = await collect(
      schemaOrgNormalizationTransform(quadStream([input]), { dataset }),
    );

    expect(quads).toHaveLength(1);
    expect(quads[0].object.value).toBe('https://schema.org/Person');
  });

  it('rewrites void:property from http to https schema.org', async () => {
    const input = quad(
      namedNode(dataset.iri.toString()),
      namedNode(`${VOID}property`),
      namedNode('http://schema.org/name'),
    );

    const quads = await collect(
      schemaOrgNormalizationTransform(quadStream([input]), { dataset }),
    );

    expect(quads).toHaveLength(1);
    expect(quads[0].object.value).toBe('https://schema.org/name');
  });

  it('does not rewrite void:vocabulary', async () => {
    const input = quad(
      namedNode(dataset.iri.toString()),
      namedNode(`${VOID}vocabulary`),
      namedNode('http://schema.org/'),
    );

    const quads = await collect(
      schemaOrgNormalizationTransform(quadStream([input]), { dataset }),
    );

    expect(quads).toHaveLength(1);
    expect(quads[0].object.value).toBe('http://schema.org/');
  });

  it('does not rewrite non-schema.org class URIs', async () => {
    const input = quad(
      namedNode(dataset.iri.toString()),
      namedNode(`${VOID}class`),
      namedNode('http://xmlns.com/foaf/0.1/Person'),
    );

    const quads = await collect(
      schemaOrgNormalizationTransform(quadStream([input]), { dataset }),
    );

    expect(quads).toHaveLength(1);
    expect(quads[0].object.value).toBe('http://xmlns.com/foaf/0.1/Person');
  });

  it('does not rewrite already-https schema.org URIs', async () => {
    const input = quad(
      namedNode(dataset.iri.toString()),
      namedNode(`${VOID}class`),
      namedNode('https://schema.org/Person'),
    );

    const quads = await collect(
      schemaOrgNormalizationTransform(quadStream([input]), { dataset }),
    );

    expect(quads).toHaveLength(1);
    expect(quads[0].object.value).toBe('https://schema.org/Person');
  });

  it('preserves subject and graph when rewriting', async () => {
    const graphNode = namedNode('http://example.com/graph');
    const input = quad(
      namedNode(dataset.iri.toString()),
      namedNode(`${VOID}class`),
      namedNode('http://schema.org/Event'),
      graphNode,
    );

    const quads = await collect(
      schemaOrgNormalizationTransform(quadStream([input]), { dataset }),
    );

    expect(quads[0].subject.value).toBe(dataset.iri.toString());
    expect(quads[0].object.value).toBe('https://schema.org/Event');
    expect(quads[0].graph.value).toBe('http://example.com/graph');
  });
});

describe('schemaOrgNormalizationPlugin', () => {
  it('returns a plugin with the correct name', () => {
    const plugin = schemaOrgNormalizationPlugin();
    expect(plugin.name).toBe('schema-org-normalization');
  });

  it('has a beforeStageWrite hook', () => {
    const plugin = schemaOrgNormalizationPlugin();
    expect(plugin.beforeStageWrite).toBeTypeOf('function');
  });

  it('normalizes http to https by default', async () => {
    const input = quad(
      namedNode(dataset.iri.toString()),
      namedNode(`${VOID}class`),
      namedNode('http://schema.org/Person'),
    );

    const quads = await collect(
      schemaOrgNormalizationPlugin().beforeStageWrite!(quadStream([input]), {
        dataset,
      }),
    );

    expect(quads[0].object.value).toBe('https://schema.org/Person');
  });

  it('normalizes https to http when reverse is true', async () => {
    const input = quad(
      namedNode(dataset.iri.toString()),
      namedNode(`${VOID}class`),
      namedNode('https://schema.org/Person'),
    );

    const quads = await collect(
      schemaOrgNormalizationPlugin({ reverse: true }).beforeStageWrite!(
        quadStream([input]),
        { dataset },
      ),
    );

    expect(quads[0].object.value).toBe('http://schema.org/Person');
  });

  it('does not rewrite http URIs when reverse is true', async () => {
    const input = quad(
      namedNode(dataset.iri.toString()),
      namedNode(`${VOID}class`),
      namedNode('http://schema.org/Person'),
    );

    const quads = await collect(
      schemaOrgNormalizationPlugin({ reverse: true }).beforeStageWrite!(
        quadStream([input]),
        { dataset },
      ),
    );

    expect(quads[0].object.value).toBe('http://schema.org/Person');
  });
});
