import {
  voidStages,
  countSubjects,
  uriSpaces,
  detectVocabularies,
  classPropertySubjects,
  UriSpaceExecutor,
  VocabularyExecutor,
  VOID_STAGE_NAMES,
} from '../src/index.js';
import { SparqlConstructExecutor } from '@lde/pipeline';
import type { Executor } from '@lde/pipeline';
import { describe, it, expect, vi } from 'vitest';
import { DataFactory } from 'n3';

const { namedNode, quad, literal } = DataFactory;

const uriSpaceMap = new Map([
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

describe('voidStages', () => {
  it('builds a stage per query, named after the query file', async () => {
    const stages = await voidStages();
    const names = stages.map((stage) => stage.name);

    expect(names).toContain(VOID_STAGE_NAMES.subjects);
    expect(names).toContain(VOID_STAGE_NAMES.entityProperties);
    // The object URI space stage is only added when a URI space map is given.
    expect(names).not.toContain(VOID_STAGE_NAMES.objectUriSpace);
  });

  it('includes the object URI space stage when a URI space map is given', async () => {
    const stages = await voidStages({ uriSpaces: uriSpaceMap });
    expect(stages.map((stage) => stage.name)).toContain(
      VOID_STAGE_NAMES.objectUriSpace,
    );
  });

  it('routes a per-stage decorator to the matching stage only', async () => {
    const decorate = vi.fn((inner: Executor) => inner);

    await voidStages({
      decorators: { [VOID_STAGE_NAMES.subjects]: decorate },
    });

    expect(decorate).toHaveBeenCalledTimes(1);
    // The decorator wraps the stage's own SparqlConstructExecutor.
    expect(decorate.mock.calls[0][0]).toBeInstanceOf(SparqlConstructExecutor);
  });

  it('composes a consumer decorator outside the built-in URI space decorator', async () => {
    const decorate = vi.fn((inner: Executor) => inner);

    await voidStages({
      uriSpaces: uriSpaceMap,
      decorators: { [VOID_STAGE_NAMES.objectUriSpace]: decorate },
    });

    expect(decorate).toHaveBeenCalledTimes(1);
    // Consumer is outermost: its inner is the built-in UriSpaceExecutor.
    expect(decorate.mock.calls[0][0]).toBeInstanceOf(UriSpaceExecutor);
  });

  it('composes a consumer decorator outside the built-in vocabulary decorator', async () => {
    const decorate = vi.fn((inner: Executor) => inner);

    await voidStages({
      decorators: { [VOID_STAGE_NAMES.entityProperties]: decorate },
    });

    expect(decorate).toHaveBeenCalledTimes(1);
    expect(decorate.mock.calls[0][0]).toBeInstanceOf(VocabularyExecutor);
  });
});

describe('standalone stage functions', () => {
  it('decorate wraps the plain CONSTRUCT executor of a global stage', async () => {
    const decorate = vi.fn((inner: Executor) => inner);
    await countSubjects({ decorate });

    expect(decorate.mock.calls[0][0]).toBeInstanceOf(SparqlConstructExecutor);
  });

  it('decorate wraps the built-in URI space decorator', async () => {
    const decorate = vi.fn((inner: Executor) => inner);
    await uriSpaces(uriSpaceMap, { decorate });

    expect(decorate.mock.calls[0][0]).toBeInstanceOf(UriSpaceExecutor);
  });

  it('decorate wraps the built-in vocabulary decorator', async () => {
    const decorate = vi.fn((inner: Executor) => inner);
    await detectVocabularies({ decorate });

    expect(decorate.mock.calls[0][0]).toBeInstanceOf(VocabularyExecutor);
  });

  it('builds a per-class stage by default', async () => {
    const stage = await classPropertySubjects();
    expect(stage.name).toBe(VOID_STAGE_NAMES.classPropertiesSubjects);
  });
});
