import { withUriSpaces } from '../src/index.js';
import { Dataset, Distribution } from '@lde/dataset';
import type { ExecutorContext } from '@lde/pipeline';
import { describe, it, expect } from 'vitest';
import { DataFactory } from 'n3';
import type { Quad } from '@rdfjs/types';

const { namedNode, quad, literal } = DataFactory;

const RDF = 'http://www.w3.org/1999/02/22-rdf-syntax-ns#';
const VOID = 'http://rdfs.org/ns/void#';
const XSD = 'http://www.w3.org/2001/XMLSchema#';
const DCTERMS = 'http://purl.org/dc/terms/';

const rdfType = namedNode(`${RDF}type`);
const voidLinkset = namedNode(`${VOID}Linkset`);
const voidSubjectsTarget = namedNode(`${VOID}subjectsTarget`);
const voidObjectsTarget = namedNode(`${VOID}objectsTarget`);
const voidTriples = namedNode(`${VOID}triples`);
const xsdInteger = namedNode(`${XSD}integer`);
const dctermsTitle = namedNode(`${DCTERMS}title`);

const dataset = new Dataset({
  iri: new URL('http://example.com/dataset/1'),
  distributions: [],
});
const distribution = new Distribution(new URL('http://example.com/sparql'));

const context: ExecutorContext = {
  dataset,
  distribution,
  stage: 'object-uri-space.rq',
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

function linksetQuads(
  linksetId: string,
  objectsTarget: string,
  count: number,
): Quad[] {
  const s = namedNode(linksetId);
  return [
    quad(s, rdfType, voidLinkset),
    quad(s, voidSubjectsTarget, namedNode(dataset.iri.toString())),
    quad(s, voidObjectsTarget, namedNode(objectsTarget)),
    quad(s, voidTriples, literal(count.toString(), xsdInteger)),
  ];
}

describe('withUriSpaces', () => {
  const uriSpaces = new Map([
    [
      'http://vocab.getty.edu/aat/',
      [
        quad(
          namedNode('https://data.getty.edu/'),
          dctermsTitle,
          literal('Art & Architecture Thesaurus', 'en'),
        ),
      ],
    ],
    [
      'https://sws.geonames.org/',
      [
        quad(
          namedNode('https://www.geonames.org/'),
          dctermsTitle,
          literal('GeoNames', 'en'),
        ),
        quad(
          namedNode('https://www.geonames.org/'),
          dctermsTitle,
          literal('GeoNames', 'nl'),
        ),
      ],
    ],
  ]);

  const transform = withUriSpaces(uriSpaces);

  it('filters to only configured URI spaces', async () => {
    const input = [
      ...linksetQuads(
        'http://example.com/.well-known/void#linkset-1',
        'http://vocab.getty.edu/aat/',
        42,
      ),
      ...linksetQuads(
        'http://example.com/.well-known/void#linkset-2',
        'http://unknown.example.org/',
        10,
      ),
    ];

    const quads = await collect(transform(quadStream(input), context));
    const objectsTargets = quads
      .filter((q) => q.predicate.equals(voidObjectsTarget))
      .map((q) => q.object.value);
    expect(objectsTargets).toEqual(['https://data.getty.edu/']);
  });

  it('aggregates counts when multiple prefixes match one URI space', async () => {
    const input = [
      ...linksetQuads(
        'http://example.com/.well-known/void#linkset-1',
        'http://vocab.getty.edu/aat/300000000/',
        20,
      ),
      ...linksetQuads(
        'http://example.com/.well-known/void#linkset-2',
        'http://vocab.getty.edu/aat/300100000/',
        30,
      ),
    ];

    const quads = await collect(transform(quadStream(input), context));
    const triplesQuad = quads.find((q) => q.predicate.equals(voidTriples));
    expect(triplesQuad?.object.value).toBe('50');
  });

  it('emits associated metadata quads for matched URI spaces', async () => {
    const input = linksetQuads(
      'http://example.com/.well-known/void#linkset-1',
      'https://sws.geonames.org/123/',
      5,
    );

    const quads = await collect(transform(quadStream(input), context));
    const titleQuads = quads.filter((q) => q.predicate.equals(dctermsTitle));
    expect(titleQuads).toHaveLength(2);
    expect(titleQuads.map((q) => q.object.value).sort()).toEqual([
      'GeoNames',
      'GeoNames',
    ]);
  });

  it('emits correct VoID Linkset structure', async () => {
    const input = linksetQuads(
      'http://example.com/.well-known/void#linkset-1',
      'http://vocab.getty.edu/aat/',
      42,
    );

    const quads = await collect(transform(quadStream(input), context));
    const linksetSubject = quads[0].subject;

    // All linkset quads share the same blank node subject.
    const linksetQuadsList = quads.filter(
      (q) => q.subject.value === linksetSubject.value,
    );
    expect(linksetQuadsList).toHaveLength(4);

    expect(
      linksetQuadsList.find(
        (q) => q.predicate.equals(rdfType) && q.object.equals(voidLinkset),
      ),
    ).toBeDefined();
    expect(
      linksetQuadsList.find(
        (q) =>
          q.predicate.equals(voidSubjectsTarget) &&
          q.object.value === dataset.iri.toString(),
      ),
    ).toBeDefined();
    expect(
      linksetQuadsList.find(
        (q) =>
          q.predicate.equals(voidObjectsTarget) &&
          q.object.value === 'https://data.getty.edu/',
      ),
    ).toBeDefined();
    expect(
      linksetQuadsList.find(
        (q) => q.predicate.equals(voidTriples) && q.object.value === '42',
      ),
    ).toBeDefined();
  });

  it('skips incomplete Linksets missing void:triples', async () => {
    const s = namedNode('http://example.com/.well-known/void#linkset-1');
    const input = [
      quad(s, rdfType, voidLinkset),
      quad(s, voidSubjectsTarget, namedNode(dataset.iri.toString())),
      quad(s, voidObjectsTarget, namedNode('http://vocab.getty.edu/aat/')),
      // No void:triples quad.
    ];

    const quads = await collect(transform(quadStream(input), context));
    expect(quads).toHaveLength(0);
  });

  it('emits nothing when no URI spaces match', async () => {
    const input = linksetQuads(
      'http://example.com/.well-known/void#linkset-1',
      'http://unknown.example.org/',
      10,
    );

    const quads = await collect(transform(quadStream(input), context));
    expect(quads).toHaveLength(0);
  });
});
