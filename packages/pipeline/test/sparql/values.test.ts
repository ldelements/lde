import { describe, it, expect } from 'vitest';
import { DataFactory } from 'n3';
import { Parser } from '@traqula/parser-sparql-1-1';
import { Generator } from '@traqula/generator-sparql-1-1';
import type {
  Pattern,
  QueryConstruct,
  PatternValues,
} from '@traqula/rules-sparql-1-1';
import {
  findSubSelect,
  injectValues,
  injectValuesOuter,
  mergeBindings,
} from '../../src/sparql/values.js';
import type { VariableBindings } from '../../src/sparql/reader.js';

const { namedNode, literal } = DataFactory;
const parser = new Parser();
const generator = new Generator();

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

  it.each([
    ['plain', literal('nl'), { value: 'nl' }],
    [
      'language-tagged',
      literal('Naam', 'nl'),
      { value: 'Naam', langOrIri: 'nl' },
    ],
  ])('injects a %s literal binding', (_kind, term, expected) => {
    const result = injectValues(baseQuery, [{ class: term }]);

    const values = result.where.patterns.find(
      (p): p is PatternValues => p.subType === 'values',
    );
    expect(values!.values[0]['class']).toMatchObject({
      type: 'term',
      subType: 'literal',
      ...expected,
    });
  });
});

describe('injectValuesOuter', () => {
  const datasetBindings = [
    { dataset: namedNode('http://example.org/dataset') },
  ];

  it('generates valid SPARQL when the WHERE clause is a bare sub-SELECT', () => {
    const query = parseConstruct(
      'CONSTRUCT { ?dataset <http://example.org/count> ?count } WHERE { SELECT (COUNT(*) AS ?count) { ?s ?p ?o } }',
    );

    const generated = generator.generate(
      injectValuesOuter(query, datasetBindings),
    );

    expect(() => parser.parse(generated)).not.toThrow();
  });

  it('injects at the outer scope, not into a nested sub-SELECT', () => {
    const query = parseConstruct(
      'CONSTRUCT { ?dataset <http://example.org/p> ?partition } WHERE { { SELECT ?class { ?s a ?class } } BIND(IRI(CONCAT(STR(?dataset), STR(?class))) AS ?partition) }',
    );

    const result = injectValuesOuter(query, datasetBindings);

    expect(hasValues(result.where.patterns)).toBe(true);
    expect(
      hasValues(findSubSelect(result.where.patterns)!.where.patterns),
    ).toBe(false);
  });
});

describe('mergeBindings', () => {
  it('returns b unchanged when a is empty', () => {
    const b = [{ s: namedNode('http://example.org/1') }];
    expect(mergeBindings([], b)).toBe(b);
  });

  it('returns a unchanged when b is empty', () => {
    const a = [{ dataset: namedNode('http://example.org/dataset') }];
    expect(mergeBindings(a, [])).toBe(a);
  });

  it('cross-products the rows of a and b', () => {
    const a: VariableBindings[] = [
      { dataset: namedNode('http://example.org/dataset') },
      { dataset: namedNode('http://example.org/dataset'), lang: literal('en') },
    ];
    const b: VariableBindings[] = [
      { s: namedNode('http://example.org/1') },
      { s: namedNode('http://example.org/2') },
    ];

    const result = mergeBindings(a, b);

    expect(result).toHaveLength(4);
    for (const row of result) {
      expect(row['dataset']).toBeDefined();
      expect(row['s']).toBeDefined();
    }
  });
});
