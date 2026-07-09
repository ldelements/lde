import {
  schemaOrgNormalizationTransform,
  schemaOrgNormalizationPlugin,
} from '../../src/index.js';
import { Dataset } from '@lde/dataset';
import { describe, it, expect } from 'vitest';
import { DataFactory } from 'n3';
import type { Quad } from '@rdfjs/types';

const { namedNode, literal, quad } = DataFactory;

const RDF_TYPE = 'http://www.w3.org/1999/02/22-rdf-syntax-ns#type';

const dataset = new Dataset({
  iri: new URL('http://example.com/dataset/1'),
  distributions: [],
});

const context = { dataset, stage: 'test' };

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
  it('rewrites an rdf:type object from http to https schema.org', async () => {
    const input = quad(
      namedNode('http://example.com/thing'),
      namedNode(RDF_TYPE),
      namedNode('http://schema.org/Person'),
    );

    const quads = await collect(
      schemaOrgNormalizationTransform(quadStream([input]), context),
    );

    expect(quads[0].object.value).toBe('https://schema.org/Person');
  });

  it('rewrites a schema.org predicate from http to https', async () => {
    const input = quad(
      namedNode('http://example.com/thing'),
      namedNode('http://schema.org/name'),
      literal('Ada'),
    );

    const quads = await collect(
      schemaOrgNormalizationTransform(quadStream([input]), context),
    );

    expect(quads[0].predicate.value).toBe('https://schema.org/name');
  });

  it('does not rewrite non-schema.org URIs', async () => {
    const input = quad(
      namedNode('http://example.com/thing'),
      namedNode(RDF_TYPE),
      namedNode('http://xmlns.com/foaf/0.1/Person'),
    );

    const quads = await collect(
      schemaOrgNormalizationTransform(quadStream([input]), context),
    );

    expect(quads[0].object.value).toBe('http://xmlns.com/foaf/0.1/Person');
  });

  it('does not rewrite already-https schema.org URIs', async () => {
    const input = quad(
      namedNode('http://example.com/thing'),
      namedNode(RDF_TYPE),
      namedNode('https://schema.org/Person'),
    );

    const quads = await collect(
      schemaOrgNormalizationTransform(quadStream([input]), context),
    );

    expect(quads[0].object.value).toBe('https://schema.org/Person');
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
      namedNode('http://example.com/thing'),
      namedNode(RDF_TYPE),
      namedNode('http://schema.org/Person'),
    );

    const quads = await collect(
      schemaOrgNormalizationPlugin().beforeStageWrite!(
        quadStream([input]),
        context,
      ),
    );

    expect(quads[0].object.value).toBe('https://schema.org/Person');
  });

  it('normalizes https to http when reverse is true', async () => {
    const input = quad(
      namedNode('http://example.com/thing'),
      namedNode(RDF_TYPE),
      namedNode('https://schema.org/Person'),
    );

    const quads = await collect(
      schemaOrgNormalizationPlugin({ reverse: true }).beforeStageWrite!(
        quadStream([input]),
        context,
      ),
    );

    expect(quads[0].object.value).toBe('http://schema.org/Person');
  });

  it('does not rewrite http URIs when reverse is true', async () => {
    const input = quad(
      namedNode('http://example.com/thing'),
      namedNode(RDF_TYPE),
      namedNode('http://schema.org/Person'),
    );

    const quads = await collect(
      schemaOrgNormalizationPlugin({ reverse: true }).beforeStageWrite!(
        quadStream([input]),
        context,
      ),
    );

    expect(quads[0].object.value).toBe('http://schema.org/Person');
  });
});
