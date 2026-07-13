import { describe, expect, it } from 'vitest';
import type { SearchType } from '@lde/search';
import {
  assertNoReservedFields,
  resolveRebuildOptions,
  stampDocuments,
} from '../src/rebuild-support.js';

async function collect<T>(iterable: AsyncIterable<T>): Promise<T[]> {
  const items: T[] = [];
  for await (const item of iterable) {
    items.push(item);
  }
  return items;
}

async function* stream<T>(items: readonly T[]): AsyncIterable<T> {
  yield* items;
}

describe('resolveRebuildOptions', () => {
  it('applies the shared defaults and keeps the residual schema options', () => {
    const resolved = resolveRebuildOptions({
      name: 'objects',
      defaultSortingField: 'rank',
    });

    expect(resolved.name).toBe('objects');
    expect(resolved.batchSize).toBe(1000);
    expect(resolved.lockTtlMs).toBe(600_000);
    expect(resolved.definitionOptions).toEqual({
      name: 'objects',
      defaultSortingField: 'rank',
    });
  });

  it('honours explicit overrides', () => {
    const resolved = resolveRebuildOptions({
      name: 'objects',
      batchSize: 50,
      lockTtlMs: 1_000,
    });
    expect(resolved.batchSize).toBe(50);
    expect(resolved.lockTtlMs).toBe(1_000);
  });
});

describe('assertNoReservedFields', () => {
  const typeWith = (...names: string[]): SearchType => ({
    name: 'Object',
    class: 'https://example.org/Object',
    fields: names.map((name) => ({ name, kind: 'keyword' })),
  });

  it('accepts a type that declares none of the reserved names', () => {
    expect(() =>
      assertNoReservedFields(typeWith('title'), ['source', 'last_seen']),
    ).not.toThrow();
  });

  it('rejects a type declaring a reserved field, naming every clash', () => {
    expect(() =>
      assertNoReservedFields(typeWith('title', 'source', 'last_seen'), [
        'source',
        'last_seen',
      ]),
    ).toThrow(/reserved bookkeeping field\(s\) “source”, “last_seen”/);
  });
});

describe('stampDocuments', () => {
  it('merges the stamp into every document as it streams', async () => {
    const stamped = await collect(
      stampDocuments(stream([{ id: 'a' }, { id: 'b' }]), {
        source: 'http://d/1',
        last_seen: 'run-1',
      }),
    );
    expect(stamped).toEqual([
      { id: 'a', source: 'http://d/1', last_seen: 'run-1' },
      { id: 'b', source: 'http://d/1', last_seen: 'run-1' },
    ]);
  });

  it('lets the stamp override a colliding document key', async () => {
    const [stamped] = await collect(
      stampDocuments(stream([{ id: 'a', source: 'wrong' }]), {
        source: 'http://d/1',
      }),
    );
    expect(stamped.source).toBe('http://d/1');
  });
});
