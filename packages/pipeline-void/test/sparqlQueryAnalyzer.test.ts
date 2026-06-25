import {
  countTriples,
  countProperties,
  countSubjects,
  countObjectLiterals,
  countObjectUris,
  countDatatypes,
  classPartitions,
  Stage,
} from '../src/index.js';
import { describe, it, expect } from 'vitest';

describe('named stage functions', () => {
  it('countTriples() returns a Stage with triples.rq', async () => {
    const stage = await countTriples();

    expect(stage).toBeInstanceOf(Stage);
    expect(stage.name).toBe('triples.rq');
  });

  it('countProperties() returns a Stage with properties.rq', async () => {
    const stage = await countProperties();

    expect(stage).toBeInstanceOf(Stage);
    expect(stage.name).toBe('properties.rq');
  });

  it('marks scalar-aggregate counts as expectsOutput', async () => {
    // Each is a single COUNT with no GROUP BY/HAVING, so an empty result can
    // only mean a truncated endpoint response.
    const counts = await Promise.all([
      countTriples(),
      countSubjects(),
      countProperties(),
      countObjectLiterals(),
      countObjectUris(),
    ]);
    for (const stage of counts) {
      expect(stage.expectsOutput).toBe(true);
    }
  });

  it('leaves stages that may legitimately be empty unmarked', async () => {
    // class-partition groups by class; datatypes joins a non-aggregate group —
    // both can be validly empty, so neither expects output.
    expect((await classPartitions()).expectsOutput).toBe(false);
    expect((await countDatatypes()).expectsOutput).toBe(false);
  });
});
