import { describe, it, expect } from 'vitest';
import { DataFactory } from 'n3';
import { Parser } from '@traqula/parser-sparql-1-1';
import type {
  Pattern,
  QueryConstruct,
  PatternValues,
} from '@traqula/rules-sparql-1-1';
import {
  findSubSelect,
  injectValues,
  mergeBindings,
} from '../../src/sparql/values.js';
import type { VariableBindings } from '../../src/sparql/reader.js';

const { namedNode, literal } = DataFactory;
const parser = new Parser();

function parseConstruct(sparql: string): QueryConstruct {
  return parser.parse(sparql) as QueryConstruct;
}

/** Check if any pattern at this level (not nested) is a VALUES clause. */
function hasValues(patterns: Pattern[]): boolean {
  return patterns.some((p) => p.subType === 'values');
}

describe('injectValues', () => {
  const baseQuery = parseConstruct(
    'CONSTRUCT { ?s a ?class } WHERE { ?s a ?class ; ?p ?o }',
  );

  it('injects a single-variable, single-row VALUES clause', () => {
    const result = injectValues(baseQuery, [
      { class: namedNode('http://example.com/Person') },
    ]);

    const values = result.where.patterns.find(
      (p): p is PatternValues => p.subType === 'values',
    );
    expect(values).toBeDefined();
    expect(values!.values).toHaveLength(1);
    expect(values!.values[0]['class']).toMatchObject({
      type: 'term',
      subType: 'namedNode',
      value: 'http://example.com/Person',
    });
  });

  it('injects a single-variable, multiple-row VALUES clause', () => {
    const result = injectValues(baseQuery, [
      { class: namedNode('http://example.com/Person') },
      { class: namedNode('http://example.com/Book') },
    ]);

    const values = result.where.patterns.find(
      (p): p is PatternValues => p.subType === 'values',
    );
    expect(values!.values).toHaveLength(2);
    expect(values!.values[0]['class']).toMatchObject({
      type: 'term',
      subType: 'namedNode',
      value: 'http://example.com/Person',
    });
    expect(values!.values[1]['class']).toMatchObject({
      type: 'term',
      subType: 'namedNode',
      value: 'http://example.com/Book',
    });
  });

  it('injects a multi-variable VALUES clause', () => {
    const result = injectValues(baseQuery, [
      {
        class: namedNode('http://example.com/Person'),
        property: namedNode('http://example.com/name'),
      },
    ]);

    const values = result.where.patterns.find(
      (p): p is PatternValues => p.subType === 'values',
    );
    expect(values!.values).toHaveLength(1);
    expect(values!.values[0]['class']).toMatchObject({
      type: 'term',
      subType: 'namedNode',
      value: 'http://example.com/Person',
    });
    expect(values!.values[0]['property']).toMatchObject({
      type: 'term',
      subType: 'namedNode',
      value: 'http://example.com/name',
    });
  });

  it('preserves existing WHERE patterns', () => {
    const result = injectValues(baseQuery, [
      { class: namedNode('http://example.com/Person') },
    ]);

    // VALUES is prepended; original BGP pattern(s) follow.
    expect(result.where.patterns.length).toBeGreaterThan(1);
    expect(result.where.patterns[0].subType).toBe('values');
  });

  it('preserves the CONSTRUCT template', () => {
    const result = injectValues(baseQuery, [
      { class: namedNode('http://example.com/Person') },
    ]);

    expect(result.template).toBeDefined();
    expect(result.template.triples.length).toBeGreaterThan(0);
  });

  it('produces an empty VALUES clause for empty bindings', () => {
    const result = injectValues(baseQuery, []);

    const values = result.where.patterns.find(
      (p): p is PatternValues => p.subType === 'values',
    );
    expect(values!.values).toHaveLength(0);
  });

  it('does not mutate the input query', () => {
    const original = parseConstruct(
      'CONSTRUCT { ?s a ?class } WHERE { ?s a ?class }',
    );
    const originalWhereLength = original.where.patterns.length;

    injectValues(original, [{ class: namedNode('http://example.com/Person') }]);

    expect(original.where.patterns.length).toBe(originalWhereLength);
  });

  it('injects VALUES into the innermost WHERE of a singly-nested subquery', () => {
    const nestedQuery = parseConstruct(
      'CONSTRUCT { ?s a ?class } WHERE { { SELECT ?class ?p WHERE { ?s a ?class ; ?p ?o } } }',
    );

    const result = injectValues(nestedQuery, [
      { class: namedNode('http://example.com/Person') },
    ]);

    // The outermost WHERE should NOT have a VALUES pattern directly.
    expect(hasValues(result.where.patterns)).toBe(false);

    // The SubSelect's WHERE should have the VALUES pattern.
    const subSelect = findSubSelect(result.where.patterns);
    expect(subSelect).toBeDefined();
    const innerValues = subSelect!.where.patterns.find(
      (p): p is PatternValues => p.subType === 'values',
    );
    expect(innerValues).toBeDefined();
    expect(innerValues!.values[0]['class']).toMatchObject({
      type: 'term',
      subType: 'namedNode',
      value: 'http://example.com/Person',
    });
  });

  it('injects VALUES into the innermost WHERE of a doubly-nested subquery', () => {
    const doublyNestedQuery = parseConstruct(
      'CONSTRUCT { ?s a ?class } WHERE { { SELECT ?class ?p WHERE { { SELECT ?class ?p ?o WHERE { ?s a ?class ; ?p ?o } } } } }',
    );

    const result = injectValues(doublyNestedQuery, [
      { class: namedNode('http://example.com/Person') },
    ]);

    // Outermost WHERE: no VALUES.
    expect(hasValues(result.where.patterns)).toBe(false);

    // Middle SubSelect's WHERE: no VALUES.
    const middleSubSelect = findSubSelect(result.where.patterns)!;
    expect(hasValues(middleSubSelect.where.patterns)).toBe(false);

    // Innermost SubSelect's WHERE: has VALUES.
    const innermostSubSelect = findSubSelect(middleSubSelect.where.patterns)!;
    const innermostValues = innermostSubSelect.where.patterns.find(
      (p): p is PatternValues => p.subType === 'values',
    );
    expect(innermostValues).toBeDefined();
    expect(innermostValues!.values[0]['class']).toMatchObject({
      type: 'term',
      subType: 'namedNode',
      value: 'http://example.com/Person',
    });
  });

  it('does not mutate the input query with nested subqueries', () => {
    const original = parseConstruct(
      'CONSTRUCT { ?s a ?class } WHERE { { SELECT ?class ?p WHERE { ?s a ?class ; ?p ?o } } }',
    );
    const subSelect = findSubSelect(original.where.patterns)!;
    const originalInnerLength = subSelect.where.patterns.length;

    injectValues(original, [{ class: namedNode('http://example.com/Person') }]);

    const subSelectAfter = findSubSelect(original.where.patterns)!;
    expect(subSelectAfter.where.patterns.length).toBe(originalInnerLength);
  });

  it('injects a plain string literal binding', () => {
    const result = injectValues(baseQuery, [{ class: literal('nl') }]);

    const values = result.where.patterns.find(
      (p): p is PatternValues => p.subType === 'values',
    );
    expect(values!.values[0]['class']).toMatchObject({
      type: 'term',
      subType: 'literal',
      value: 'nl',
    });
  });

  it('injects a language-tagged literal binding', () => {
    const result = injectValues(baseQuery, [{ class: literal('Naam', 'nl') }]);

    const values = result.where.patterns.find(
      (p): p is PatternValues => p.subType === 'values',
    );
    expect(values!.values[0]['class']).toMatchObject({
      type: 'term',
      subType: 'literal',
      value: 'Naam',
      langOrIri: 'nl',
    });
  });
});

describe('mergeBindings', () => {
  it('returns the item-level rows unchanged when dataset-level is empty', () => {
    const itemLevel = [{ s: namedNode('http://example.org/1') }];
    expect(mergeBindings([], itemLevel)).toBe(itemLevel);
  });

  it('returns the dataset-level rows unchanged when item-level is empty', () => {
    const datasetLevel = [{ dataset: namedNode('http://example.org/dataset') }];
    expect(mergeBindings(datasetLevel, [])).toBe(datasetLevel);
  });

  it('cross-products dataset-level and item-level rows', () => {
    const datasetLevel: VariableBindings[] = [
      { dataset: namedNode('http://example.org/dataset') },
      { dataset: namedNode('http://example.org/dataset'), lang: literal('en') },
    ];
    const itemLevel: VariableBindings[] = [
      { s: namedNode('http://example.org/1') },
      { s: namedNode('http://example.org/2') },
    ];

    const result = mergeBindings(datasetLevel, itemLevel);

    expect(result).toHaveLength(4);
    for (const row of result) {
      expect(row['dataset']).toBeDefined();
      expect(row['s']).toBeDefined();
    }
  });
});
