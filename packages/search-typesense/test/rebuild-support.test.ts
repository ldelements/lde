import { describe, expect, it } from 'vitest';
import { type SearchType } from '@lde/search';
import { resolveRebuildOptions } from '../src/rebuild-support.js';

describe('resolveRebuildOptions', () => {
  const OBJECT: SearchType = {
    name: 'MuseumObject',
    class: 'https://example.org/Object',
    fields: [],
  };

  it('applies the shared defaults and keeps the residual schema options', () => {
    const resolved = resolveRebuildOptions(OBJECT, {
      collectionNameFor: () => 'objects',
      defaultSortingField: 'rank',
    });

    expect(resolved.batchSize).toBe(1000);
    expect(resolved.lockTtlMs).toBe(600_000);
    expect(resolved.definitionOptions.defaultSortingField).toBe('rank');
    expect(resolved.definitionOptions.collectionNameFor(OBJECT)).toBe(
      'objects',
    );
  });

  it('honours explicit overrides', () => {
    const resolved = resolveRebuildOptions(OBJECT, {
      collectionNameFor: () => 'objects',
      batchSize: 50,
      lockTtlMs: 1_000,
    });
    expect(resolved.batchSize).toBe(50);
    expect(resolved.lockTtlMs).toBe(1_000);
  });

  it('derives the name from the type when none is given', () => {
    const resolved = resolveRebuildOptions(OBJECT, {
      defaultSortingField: 'rank',
    });

    // The definition must be built for the very collection the writer talks
    // to, so the naming is resolved to a total function here rather than left
    // undefined – and it names a PEER as readily as this type, which is what a
    // join’s reference field needs.
    expect(resolved.definitionOptions.defaultSortingField).toBe('rank');
    expect(resolved.definitionOptions.collectionNameFor(OBJECT)).toBe(
      'museum_objects',
    );
    expect(
      resolved.definitionOptions.collectionNameFor({
        name: 'Publisher',
        class: 'https://example.org/Publisher',
        fields: [],
      }),
    ).toBe('publishers');
  });
});
