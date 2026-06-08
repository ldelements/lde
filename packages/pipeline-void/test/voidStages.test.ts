import {
  VOID_STAGE_NAMES,
  detectVocabularies,
  subjectUriSpaces,
  uriSpaces,
  voidStages,
  Stage,
} from '../src/index.js';
import type { ExecutorContext, QuadTransform } from '../src/index.js';
import { describe, it, expect } from 'vitest';
import { DataFactory } from 'n3';
import type { Quad } from '@rdfjs/types';

const { namedNode, quad, literal } = DataFactory;

const noopTransform: QuadTransform<ExecutorContext> = (quads) => quads;

/** Names produced by {@link voidStages} without the optional URI space stage. */
const baseStageNames = [
  VOID_STAGE_NAMES.subjects,
  VOID_STAGE_NAMES.properties,
  VOID_STAGE_NAMES.objectLiterals,
  VOID_STAGE_NAMES.objectUris,
  VOID_STAGE_NAMES.datatypes,
  VOID_STAGE_NAMES.triples,
  VOID_STAGE_NAMES.classPartitions,
  VOID_STAGE_NAMES.classPropertySubjects,
  VOID_STAGE_NAMES.classPropertyObjects,
  VOID_STAGE_NAMES.perClassDatatypes,
  VOID_STAGE_NAMES.perClassObjectClasses,
  VOID_STAGE_NAMES.perClassLanguages,
  VOID_STAGE_NAMES.licenses,
  VOID_STAGE_NAMES.vocabularies,
  VOID_STAGE_NAMES.subjectUriSpace,
];

describe('voidStages', () => {
  it('creates every stage in the recommended order', async () => {
    const stages = await voidStages();

    expect(stages.every((stage) => stage instanceof Stage)).toBe(true);
    expect(stages.map((stage) => stage.name)).toEqual(baseStageNames);
  });

  it('warms the class partition cache before the per-class stages', async () => {
    const names = (await voidStages()).map((stage) => stage.name);
    expect(names.indexOf(VOID_STAGE_NAMES.classPartitions)).toBeLessThan(
      names.indexOf(VOID_STAGE_NAMES.classPropertySubjects),
    );
  });

  it('appends the object URI space stage when a URI space map is given', async () => {
    const uriSpaceMap = new Map<string, readonly Quad[]>([
      [
        'http://vocab.getty.edu/aat/',
        [
          quad(
            namedNode('https://data.getty.edu/'),
            namedNode('http://purl.org/dc/terms/title'),
            literal('Art & Architecture Thesaurus', 'en'),
          ),
        ],
      ],
    ]);

    const names = (await voidStages({ uriSpaces: uriSpaceMap })).map(
      (stage) => stage.name,
    );
    expect(names).toEqual([...baseStageNames, VOID_STAGE_NAMES.objectUriSpace]);
  });

  it('routes a consumer transform onto a stage without dropping it', async () => {
    const stages = await voidStages({
      transforms: {
        [VOID_STAGE_NAMES.subjectUriSpace]: noopTransform,
      },
    });

    // Routing a transform must not change which stages are produced.
    expect(stages.map((stage) => stage.name)).toEqual(baseStageNames);
  });

  it('accepts per-class batching options', async () => {
    const stages = await voidStages({ batchSize: 1, maxConcurrency: 2 });
    expect(stages.map((stage) => stage.name)).toEqual(baseStageNames);
  });
});

describe('stages with a built-in transform', () => {
  it('subjectUriSpaces creates the subject URI space stage', async () => {
    const stage = await subjectUriSpaces();
    expect(stage.name).toBe(VOID_STAGE_NAMES.subjectUriSpace);
  });

  it('uriSpaces creates the object URI space stage', async () => {
    const stage = await uriSpaces(new Map());
    expect(stage.name).toBe(VOID_STAGE_NAMES.objectUriSpace);
  });

  it('uriSpaces composes a consumer transform after the built-in one', async () => {
    const stage = await uriSpaces(new Map(), { transform: noopTransform });
    expect(stage.name).toBe(VOID_STAGE_NAMES.objectUriSpace);
    expect(stage).toBeInstanceOf(Stage);
  });

  it('detectVocabularies creates the entity properties stage', async () => {
    const stage = await detectVocabularies();
    expect(stage.name).toBe(VOID_STAGE_NAMES.vocabularies);
  });

  it('detectVocabularies accepts extra vocabularies and a consumer transform', async () => {
    const stage = await detectVocabularies({
      vocabularies: ['http://example.com/vocab/'],
      transform: noopTransform,
    });
    expect(stage.name).toBe(VOID_STAGE_NAMES.vocabularies);
  });
});
