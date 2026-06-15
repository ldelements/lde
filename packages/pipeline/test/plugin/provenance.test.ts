import { provenanceTransform, provenancePlugin } from '../../src/index.js';
import { Dataset } from '@lde/dataset';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { DataFactory } from 'n3';
import type { Quad } from '@rdfjs/types';

const { namedNode, literal, quad } = DataFactory;

const PROV = 'http://www.w3.org/ns/prov#';
const RDF_TYPE = 'http://www.w3.org/1999/02/22-rdf-syntax-ns#type';
const XSD_DATE_TIME = 'http://www.w3.org/2001/XMLSchema#dateTime';

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

function emptyStream(): AsyncIterable<Quad> {
  return quadStream([]);
}

function quadStream(quads: Quad[]): AsyncIterable<Quad> {
  return (async function* () {
    yield* quads;
  })();
}

describe('provenanceTransform', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2024-01-15T10:00:00.000Z'));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('adds prov:Entity type', async () => {
    const quads = await collect(
      provenanceTransform(emptyStream(), { dataset, stage: 'describe' }),
    );

    const entityQuads = quads.filter(
      (q) =>
        q.subject.value === dataset.iri.toString() &&
        q.predicate.value === RDF_TYPE &&
        q.object.value === `${PROV}Entity`,
    );
    expect(entityQuads).toHaveLength(1);
  });

  it('adds prov:wasGeneratedBy linking to an activity', async () => {
    const quads = await collect(
      provenanceTransform(emptyStream(), { dataset, stage: 'describe' }),
    );

    const generatedByQuads = quads.filter(
      (q) =>
        q.subject.value === dataset.iri.toString() &&
        q.predicate.value === `${PROV}wasGeneratedBy`,
    );
    expect(generatedByQuads).toHaveLength(1);
    expect(generatedByQuads[0].object.termType).toBe('NamedNode');
  });

  it('adds prov:Activity type to the activity', async () => {
    const quads = await collect(
      provenanceTransform(emptyStream(), { dataset, stage: 'describe' }),
    );

    const activityQuads = quads.filter(
      (q) =>
        q.predicate.value === RDF_TYPE && q.object.value === `${PROV}Activity`,
    );
    expect(activityQuads).toHaveLength(1);
    expect(activityQuads[0].subject.termType).toBe('NamedNode');
  });

  it('adds prov:startedAtTime as xsd:dateTime', async () => {
    const quads = await collect(
      provenanceTransform(emptyStream(), { dataset, stage: 'describe' }),
    );

    const startQuads = quads.filter(
      (q) => q.predicate.value === `${PROV}startedAtTime`,
    );
    expect(startQuads).toHaveLength(1);
    expect(startQuads[0].object.value).toBe('2024-01-15T10:00:00.000Z');
    expect(
      'datatype' in startQuads[0].object
        ? (startQuads[0].object as { datatype: { value: string } }).datatype
            .value
        : undefined,
    ).toBe(XSD_DATE_TIME);
  });

  it('adds prov:endedAtTime as xsd:dateTime', async () => {
    // Advance time before consuming the stream (triggers endedAt).
    vi.setSystemTime(new Date('2024-01-15T10:05:00.000Z'));
    const quads = await collect(
      provenanceTransform(emptyStream(), { dataset, stage: 'describe' }),
    );

    const endQuads = quads.filter(
      (q) => q.predicate.value === `${PROV}endedAtTime`,
    );
    expect(endQuads).toHaveLength(1);
    expect(endQuads[0].object.value).toBe('2024-01-15T10:05:00.000Z');
    expect(
      'datatype' in endQuads[0].object
        ? (endQuads[0].object as { datatype: { value: string } }).datatype.value
        : undefined,
    ).toBe(XSD_DATE_TIME);
  });

  it('preserves existing triples', async () => {
    const existing = quad(
      namedNode(dataset.iri.toString()),
      namedNode('http://rdfs.org/ns/void#triples'),
      literal('100'),
    );

    const quads = await collect(
      provenanceTransform(quadStream([existing]), {
        dataset,
        stage: 'describe',
      }),
    );

    const existingQuads = quads.filter(
      (q) => q.predicate.value === 'http://rdfs.org/ns/void#triples',
    );
    expect(existingQuads).toHaveLength(1);
    // 1 existing + 5 provenance triples
    expect(quads).toHaveLength(6);
  });

  it('mints the activity as an IRI, not a blank node (issue #474)', async () => {
    const quads = await collect(
      provenanceTransform(emptyStream(), { dataset, stage: 'describe' }),
    );

    const activitySubject = quads.find(
      (q) =>
        q.predicate.value === RDF_TYPE && q.object.value === `${PROV}Activity`,
    )!.subject;
    expect(activitySubject.termType).toBe('NamedNode');
  });

  it('mints a stable activity IRI across runs (idempotent)', async () => {
    const activityFor = async () =>
      (
        await collect(
          provenanceTransform(emptyStream(), { dataset, stage: 'describe' }),
        )
      ).find(
        (q) =>
          q.predicate.value === RDF_TYPE &&
          q.object.value === `${PROV}Activity`,
      )!.subject.value;

    expect(await activityFor()).toBe(await activityFor());
  });

  it('mints distinct activity IRIs per stage', async () => {
    const activityFor = async (stage: string) =>
      (
        await collect(provenanceTransform(emptyStream(), { dataset, stage }))
      ).find(
        (q) =>
          q.predicate.value === RDF_TYPE &&
          q.object.value === `${PROV}Activity`,
      )!.subject.value;

    expect(await activityFor('describe')).not.toBe(
      await activityFor('measure'),
    );
  });
});

describe('provenancePlugin', () => {
  it('returns a plugin with name "provenance"', () => {
    const plugin = provenancePlugin();
    expect(plugin.name).toBe('provenance');
  });

  it('has a beforeStageWrite hook', () => {
    const plugin = provenancePlugin();
    expect(plugin.beforeStageWrite).toBeDefined();
  });

  it('beforeStageWrite is provenanceTransform', () => {
    const plugin = provenancePlugin();
    expect(plugin.beforeStageWrite).toBe(provenanceTransform);
  });
});
