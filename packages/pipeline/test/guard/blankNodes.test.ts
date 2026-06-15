import {
  assertNoBlankNodes,
  blankNodes,
  failOnBlankNodes,
} from '../../src/index.js';
import { describe, it, expect } from 'vitest';
import { DataFactory } from 'n3';
import type { Quad } from '@rdfjs/types';

const { namedNode, literal, quad, blankNode, defaultGraph } = DataFactory;

const s = namedNode('http://example.org/dataset');
const p = namedNode('http://www.w3.org/ns/prov#wasGeneratedBy');

const clean: Quad[] = [
  quad(s, namedNode('http://rdfs.org/ns/void#triples'), literal('42')),
  quad(s, p, namedNode('http://example.org/dataset#activity-abc')),
];

async function* stream(quads: Quad[]): AsyncIterable<Quad> {
  yield* quads;
}

async function drain(quads: AsyncIterable<Quad>): Promise<Quad[]> {
  const out: Quad[] = [];
  for await (const q of quads) out.push(q);
  return out;
}

describe('blankNodes', () => {
  it('returns nothing for blank-node-free quads', () => {
    expect(blankNodes(clean)).toEqual([]);
  });

  it('reports blank nodes in subject, object, and graph position', () => {
    const quads = [
      quad(blankNode('inSubject'), p, s),
      quad(s, p, blankNode('inObject')),
      quad(s, p, s, blankNode('inGraph')),
    ];
    expect(new Set(blankNodes(quads))).toEqual(
      new Set(['inSubject', 'inObject', 'inGraph']),
    );
  });

  it('deduplicates repeated labels', () => {
    const a = blankNode('a');
    expect(blankNodes([quad(a, p, s), quad(s, p, a)])).toEqual(['a']);
  });
});

describe('assertNoBlankNodes', () => {
  it('does not throw for blank-node-free quads', () => {
    expect(() => assertNoBlankNodes(clean)).not.toThrow();
  });

  it('throws, naming the offending label, when a blank node is present', () => {
    expect(() => assertNoBlankNodes([quad(s, p, blankNode('n3-50'))])).toThrow(
      /n3-50/,
    );
  });
});

describe('failOnBlankNodes', () => {
  it('passes blank-node-free quads through unchanged', async () => {
    const out = await drain(failOnBlankNodes()(stream(clean), {}));
    expect(out).toEqual(clean);
  });

  it('throws on the first blank node reaching the writer', async () => {
    const quads = [clean[0], quad(s, p, blankNode('n3-7')), clean[1]];
    await expect(drain(failOnBlankNodes()(stream(quads), {}))).rejects.toThrow(
      /n3-7/,
    );
  });

  it('ignores the default graph (not a blank node)', async () => {
    const out = await drain(
      failOnBlankNodes()(stream([quad(s, p, s, defaultGraph())]), {}),
    );
    expect(out).toHaveLength(1);
  });
});
