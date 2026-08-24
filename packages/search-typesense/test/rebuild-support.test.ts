import { describe, expect, it } from 'vitest';
import { defineSearchType, searchSchema, type SearchType } from '@lde/search';
import {
  assertNoReservedFields,
  assertSweepableProvenanceField,
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

describe('assertSweepableProvenanceField', () => {
  const typeWith = (field: object): SearchType => ({
    name: 'Object',
    class: 'https://example.org/Object',
    fields: [field] as SearchType['fields'],
  });

  it('accepts a type declaring no dataset field at all', () => {
    expect(() =>
      assertSweepableProvenanceField(
        typeWith({ name: 'title', kind: 'keyword' }),
        {
          requireFacetable: true,
        },
      ),
    ).not.toThrow();
  });

  it('accepts a facetable, single-valued declaration', () => {
    expect(() =>
      assertSweepableProvenanceField(
        typeWith({
          name: 'dataset',
          kind: 'reference',
          from: 'dataset',
          facetable: true,
        }),
        { requireFacetable: true },
      ),
    ).not.toThrow();
  });

  it('ignores an internal dataset field: the projection prunes it before the writer', () => {
    expect(() =>
      assertSweepableProvenanceField(
        typeWith({ name: 'dataset', kind: 'reference', from: 'dataset' }),
        { requireFacetable: true },
      ),
    ).not.toThrow();
  });

  it('rejects an array declaration, which a membership sweep would over-delete by', () => {
    expect(() =>
      assertSweepableProvenanceField(
        typeWith({
          name: 'dataset',
          kind: 'reference',
          from: 'dataset',
          array: true,
          facetable: true,
        }),
        { requireFacetable: true },
      ),
    ).toThrow(/array/);
  });

  it('rejects a transform, which would stop the stored value matching the selection', () => {
    expect(() =>
      assertSweepableProvenanceField(
        typeWith({
          name: 'dataset',
          kind: 'reference',
          from: 'dataset',
          facetable: true,
          transform: (value: string) => value.replace('https://', 'http://'),
        }),
        { requireFacetable: true },
      ),
    ).toThrow(/transform/);
  });

  it('requires facetable only where the writer enumerates the indexed datasets', () => {
    const notFacetable = typeWith({
      name: 'dataset',
      kind: 'reference',
      from: 'dataset',
      output: true,
    });

    expect(() =>
      assertSweepableProvenanceField(notFacetable, { requireFacetable: true }),
    ).toThrow(/facetable/);
    // Blue/green only ever filters by a known IRI, so it needs no facet.
    expect(() =>
      assertSweepableProvenanceField(notFacetable, { requireFacetable: false }),
    ).not.toThrow();
  });

  it('rejects a dataset field whose facet a policy narrows, where the writer enumerates by it', () => {
    // The engine would facet only the admitted datasets, so the sweep would
    // never see – and never reconcile – the ones the policy excludes.
    const dataset = defineSearchType({
      name: 'Dataset',
      class: 'https://example.org/Dataset',
      facetKeys: { only: (id) => id.startsWith('https://registry/') },
      fields: [
        {
          name: 'label',
          kind: 'text',
          locales: ['und'],
          output: true,
          searchable: { weight: 1 },
        },
      ],
    });
    const object = defineSearchType({
      name: 'Object',
      class: 'https://example.org/Object',
      fields: [
        {
          name: 'dataset',
          kind: 'reference',
          from: 'dataset',
          facetable: true,
          ref: { strategy: 'lookup', target: 'Dataset' },
        },
      ],
    });
    const schema = searchSchema(dataset, object);

    expect(() =>
      assertSweepableProvenanceField(object, {
        requireFacetable: true,
        schema,
      }),
    ).toThrow(/inherits a facet policy/);
    expect(() =>
      assertSweepableProvenanceField(object, {
        requireFacetable: false,
        schema,
      }),
    ).not.toThrow();
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
