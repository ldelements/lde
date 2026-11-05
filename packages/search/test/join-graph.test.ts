import { describe, expect, it } from 'vitest';
import { joinGraph, MAX_JOIN_DEPTH } from '../src/join-graph.js';
import {
  defineSearchType,
  searchSchema,
  type ReferenceField,
  type RootType,
  type SearchType,
} from '../src/schema.js';

/** A label-source-shaped root type: an indexed type serving `label`. */
function labelSource(name: string, fields: SearchType['fields'] = []) {
  return defineSearchType({
    name,
    class: `https://example.org/${name}`,
    fields: [
      {
        name: 'label',
        path: 'http://www.w3.org/2000/01/rdf-schema#label',
        kind: 'text',
        locales: ['nl'],
        output: true,
        searchable: { weight: 5 },
      },
      ...fields,
    ],
  });
}

/** A joinable (or plain) reference declaration. */
function reference(
  name: string,
  labelSourceName: string,
  extra: Partial<ReferenceField> = {},
): ReferenceField {
  return {
    name,
    path: `https://example.org/${name}`,
    kind: 'reference',
    filterable: true,
    labelSource: labelSourceName,
    ...extra,
  };
}

const PUBLISHER = labelSource('Publisher');
const DATASET = labelSource('Dataset', [
  reference('publisher', 'Publisher', { joinable: true }),
]);
const CREATIVE_WORK = labelSource('CreativeWork', [
  reference('dataset', 'Dataset', { joinable: true }),
]);

const names = (types: readonly RootType[]) => types.map((type) => type.name);

describe('joinGraph', () => {
  it('is built once per schema and returned again on the next call', () => {
    const schema = searchSchema(PUBLISHER, DATASET, CREATIVE_WORK);
    expect(joinGraph(schema)).toBe(joinGraph(schema));
  });

  describe('resolve', () => {
    const schema = searchSchema(PUBLISHER, DATASET, CREATIVE_WORK);
    const joins = joinGraph(schema);

    it('walks a path of joinable field names hop by hop', () => {
      expect(joins.resolve(CREATIVE_WORK, ['dataset'])).toBe(DATASET);
      expect(joins.resolve(CREATIVE_WORK, ['dataset', 'publisher'])).toBe(
        PUBLISHER,
      );
    });

    it('resolves the empty path to the type itself', () => {
      expect(joins.resolve(CREATIVE_WORK, [])).toBe(CREATIVE_WORK);
    });

    it('does not resolve a field that is not a joinable reference', () => {
      expect(joins.resolve(CREATIVE_WORK, ['label'])).toBeUndefined();
      expect(joins.resolve(CREATIVE_WORK, ['nonesuch'])).toBeUndefined();
      // A reference declaring no `joinable` keeps its labels and its id
      // filtering, but states no edge.
      const plain = labelSource('Plain', [reference('publisher', 'Publisher')]);
      const other = searchSchema(PUBLISHER, plain);
      expect(joinGraph(other).resolve(plain, ['publisher'])).toBeUndefined();
    });

    it('does not resolve a path deeper than the cap', () => {
      const deep = ['dataset', 'publisher', 'publisher', 'publisher'];
      expect(deep.length).toBeGreaterThan(MAX_JOIN_DEPTH);
      expect(joins.resolve(CREATIVE_WORK, deep)).toBeUndefined();
    });

    it('does not resolve from a type outside this schema', () => {
      // A Reference Type is never indexed, so it has no collection to join
      // from; nor has a Root Type declared against another schema.
      const referenceType = defineSearchType({ name: 'Loose', fields: [] });
      expect(joins.resolve(referenceType, ['dataset'])).toBeUndefined();
      expect(joins.resolve(labelSource('Dataset'), ['publisher'])).toBe(
        undefined,
      );
    });
  });

  describe('components', () => {
    it('groups every type that references another, transitively', () => {
      const loose = labelSource('Loose');
      const schema = searchSchema(PUBLISHER, DATASET, CREATIVE_WORK, loose);
      const components = joinGraph(schema).components.map(names);
      expect(components).toEqual([
        // Referenced first: the order a writer may create the collections in.
        ['Publisher', 'Dataset', 'CreativeWork'],
        ['Loose'],
      ]);
    });

    it('makes a type with no joinable edge a singleton component', () => {
      const schema = searchSchema(PUBLISHER, labelSource('Other'));
      expect(joinGraph(schema).components.map(names)).toEqual([
        ['Publisher'],
        ['Other'],
      ]);
    });

    it('groups undirected but orders directed', () => {
      // Two referrers, one referent: nobody references the referrers, yet all
      // three rebuild together because the edges connect them.
      const dataset = labelSource('Dataset', [
        reference('publisher', 'Publisher', { joinable: true }),
      ]);
      const person = labelSource('Person', [
        reference('affiliation', 'Publisher', { joinable: true }),
      ]);
      const schema = searchSchema(PUBLISHER, dataset, person);
      const [component] = joinGraph(schema).components;
      expect(names(component)).toEqual(['Publisher', 'Dataset', 'Person']);
    });
  });

  describe('declaration rules', () => {
    it('rejects a second joinable reference to the same target', () => {
      const dataset = labelSource('Dataset', [
        reference('publisher', 'Publisher', { joinable: true }),
        reference('creator', 'Publisher', { joinable: true }),
      ]);
      expect(() => searchSchema(PUBLISHER, dataset)).toThrow(
        /two joinable references to “Publisher” \(“publisher” and “creator”\)/,
      );
    });

    it('allows a second, non-joinable reference to the same target', () => {
      const dataset = labelSource('Dataset', [
        reference('publisher', 'Publisher', { joinable: true }),
        reference('creator', 'Publisher'),
      ]);
      expect(() => searchSchema(PUBLISHER, dataset)).not.toThrow();
    });

    it('rejects a cycle', () => {
      const a = labelSource('A', [reference('b', 'B', { joinable: true })]);
      const b = labelSource('B', [reference('a', 'A', { joinable: true })]);
      expect(() => searchSchema(a, b)).toThrow(/Join cycle “A” → “B” → “A”/);
    });

    it('rejects a self-reference as a cycle', () => {
      const a = labelSource('A', [
        reference('parent', 'A', { joinable: true }),
      ]);
      expect(() => searchSchema(a)).toThrow(/Join cycle “A” → “A”/);
    });
  });
});
