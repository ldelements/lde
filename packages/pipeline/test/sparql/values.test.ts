import { describe, it, expect } from 'vitest';
import { DataFactory } from 'n3';
import { Parser } from '@traqula/parser-sparql-1-1';
import { Generator } from '@traqula/generator-sparql-1-1';
import type {
  Pattern,
  PatternGroup,
  PatternUnion,
  QueryConstruct,
  PatternValues,
} from '@traqula/rules-sparql-1-1';
import { findSubSelect, injectValues } from '../../src/sparql/values.js';

const { namedNode } = DataFactory;
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

  describe('into UNION branches', () => {
    const roots = [{ root: namedNode('http://example.com/a') }];

    function branchesOf(where: PatternGroup): PatternGroup[] {
      expect(where.patterns).toHaveLength(1);
      return (where.patterns[0] as PatternUnion).patterns;
    }

    it('puts the VALUES first in each branch of a single top-level UNION', () => {
      const query = parseConstruct(
        `CONSTRUCT { ?root ?p ?value } WHERE {
          { ?root <http://example.com/name> ?value OPTIONAL { ?value a ?type } }
          UNION
          { ?root <http://example.com/a>/<http://example.com/b> ?value FILTER(isIRI(?root)) }
        }`,
      );

      const result = injectValues(query, roots);

      expect(hasValues(result.where.patterns)).toBe(false);
      for (const branch of branchesOf(result.where)) {
        expect(branch.patterns[0].subType).toBe('values');
      }
      expect(generator.generate(result)).toContain('VALUES');
    });

    it('keeps the VALUES before the UNION when a branch binds a VALUES variable only in an OPTIONAL', () => {
      const query = parseConstruct(
        `CONSTRUCT { ?root ?p ?value } WHERE {
          { ?root <http://example.com/name> ?value }
          UNION
          { ?other <http://example.com/name> ?value OPTIONAL { ?root <http://example.com/knows> ?other } }
        }`,
      );

      const result = injectValues(query, roots);

      expect(result.where.patterns[0].subType).toBe('values');
      for (const branch of (result.where.patterns[1] as PatternUnion)
        .patterns) {
        expect(hasValues(branch.patterns)).toBe(false);
      }
    });

    it('keeps the VALUES before the UNION when a branch binds a VALUES variable only in a blank node property list', () => {
      const query = parseConstruct(
        `CONSTRUCT { ?root ?p ?value } WHERE {
          { ?root <http://example.com/name> ?value }
          UNION
          { [ <http://example.com/knows> ?root ] . ?value a <http://example.com/Thing> }
        }`,
      );

      const result = injectValues(query, roots);

      expect(result.where.patterns[0].subType).toBe('values');
    });

    it.each([
      ['an OPTIONAL', 'OPTIONAL { ?root <http://example.com/knows> ?other }'],
      ['a MINUS', 'MINUS { ?root <http://example.com/deleted> true }'],
      ['a BIND', 'BIND(?root AS ?id)'],
    ])(
      'keeps the VALUES before the UNION when %s precedes the triple pattern that binds a VALUES variable',
      (_, pattern) => {
        const query = parseConstruct(
          `CONSTRUCT { ?root ?p ?value } WHERE {
            { ?root <http://example.com/name> ?value }
            UNION
            { ${pattern} ?root <http://example.com/label> ?value }
          }`,
        );

        const result = injectValues(query, roots);

        expect(result.where.patterns[0].subType).toBe('values');
      },
    );

    it('keeps the VALUES before a WHERE that is not a single UNION', () => {
      const query = parseConstruct(
        `CONSTRUCT { ?root ?p ?value } WHERE {
          ?root a <http://example.com/Thing> .
          { ?root <http://example.com/name> ?value }
          UNION
          { ?root <http://example.com/label> ?value }
        }`,
      );

      const result = injectValues(query, roots);

      expect(result.where.patterns[0].subType).toBe('values');
      const union = result.where.patterns.find(
        (pattern): pattern is PatternUnion => pattern.subType === 'union',
      )!;
      for (const branch of union.patterns) {
        expect(hasValues(branch.patterns)).toBe(false);
      }
    });

    it('pushes the VALUES into the UNION of the innermost sub-SELECT', () => {
      const query = parseConstruct(
        `CONSTRUCT { ?root ?p ?value } WHERE {
          { SELECT ?root ?p ?value WHERE {
            { ?root ?p ?value }
            UNION
            { ?value ?p ?root }
          } }
        }`,
      );

      const result = injectValues(query, roots);

      expect(hasValues(result.where.patterns)).toBe(false);
      const subSelect = findSubSelect(result.where.patterns)!;
      expect(hasValues(subSelect.where.patterns)).toBe(false);
      for (const branch of branchesOf(subSelect.where)) {
        expect(branch.patterns[0].subType).toBe('values');
      }
    });
  });
});
