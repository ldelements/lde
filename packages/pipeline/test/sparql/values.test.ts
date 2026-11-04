import { describe, it, expect } from 'vitest';
import { DataFactory } from 'n3';
import { Parser } from '@traqula/parser-sparql-1-1';
import { Generator } from '@traqula/generator-sparql-1-1';
import type {
  Pattern,
  PatternGroup,
  PatternUnion,
  QueryConstruct,
  QuerySelect,
  PatternValues,
} from '@traqula/rules-sparql-1-1';
import type { DatasetBindings } from '../../src/sparql/datasetBindings.js';
import {
  findSubSelect,
  injectValues,
  injectDatasetBindings,
} from '../../src/sparql/values.js';

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

describe('injectDatasetBindings', () => {
  const dataset = { dataset: namedNode('http://example.org/dataset') };
  const languages = [
    { datasetLanguage: literal('nl') },
    { datasetLanguage: literal('en') },
  ];
  const publisherNames = [
    { datasetPublisherName: literal('Naam', 'nl') },
    { datasetPublisherName: literal('Name', 'en') },
  ];
  const bindings = [[dataset], languages, publisherNames];

  function inject(sparql: string): string {
    return generator.generate(
      injectDatasetBindings(parseConstruct(sparql), bindings),
    );
  }

  it('leaves a query that references no binding unchanged', () => {
    const query = parseConstruct('CONSTRUCT { ?s a ?c } WHERE { ?s a ?c }');

    expect(injectDatasetBindings(query, bindings)).toBe(query);
  });

  it('binds a variable referenced only in the template', () => {
    const generated = inject(
      'CONSTRUCT { ?s <urn:in> ?dataset } WHERE { ?s a ?c }',
    );

    expect(generated).toContain('VALUES');
    expect(generated).toContain('<http://example.org/dataset>');
    expect(generated).not.toContain('datasetLanguage');
  });

  it('binds a variable referenced only in the WHERE clause', () => {
    const generated = inject(
      'CONSTRUCT { ?s a ?c } WHERE { ?s a ?c ; <urn:lang> ?l FILTER(?l = ?datasetLanguage) }',
    );

    expect(generated).toContain('"nl"');
    expect(generated).not.toContain('UNION');
    expect(generated).not.toContain('<http://example.org/dataset>');
  });

  it('does not bind a variable that merely starts with a binding name', () => {
    const query = parseConstruct(
      'CONSTRUCT { ?s <urn:t> ?datasetType } WHERE { ?s a ?datasetType }',
    );

    expect(injectDatasetBindings(query, bindings)).toBe(query);
  });

  it('leaves a referenced variable without a binding unbound rather than UNDEF', () => {
    const result = injectDatasetBindings(
      parseConstruct(
        'CONSTRUCT { ?dataset <urn:license> ?datasetLicense } WHERE { }',
      ),
      bindings,
    );

    expect(result.where.patterns[0]).toMatchObject({
      subType: 'values',
      variables: [{ value: 'dataset' }],
    });
    expect(generator.generate(result)).not.toContain('UNDEF');
  });

  it('does not bind a variable that is out of scope inside a sub-SELECT', () => {
    const query = parseConstruct(
      'CONSTRUCT { ?s a ?c } WHERE { { SELECT ?s ?c { ?s a ?c ; <urn:lang> ?datasetLanguage } } }',
    );

    expect(injectDatasetBindings(query, bindings)).toBe(query);
  });

  it('binds a variable a sub-SELECT * exposes', () => {
    const generated = inject(
      'CONSTRUCT { ?s a ?c } WHERE { { SELECT * { ?s a ?c ; <urn:lang> ?datasetLanguage } } }',
    );

    expect(generated).toContain('"nl"');
  });

  it('does not bind a variable a sub-SELECT only aggregates', () => {
    const query = parseConstruct(
      'CONSTRUCT { ?s <urn:n> ?n } WHERE { { SELECT ?s (COUNT(?datasetLanguage) AS ?n) { ?s <urn:lang> ?datasetLanguage } GROUP BY ?s } }',
    );

    expect(injectDatasetBindings(query, bindings)).toBe(query);
  });

  it('puts independent multi-valued groups in UNION branches, with single-valued ones outside', () => {
    const result = injectDatasetBindings(
      parseConstruct(
        'CONSTRUCT { ?dataset <urn:l> ?datasetLanguage ; <urn:n> ?datasetPublisherName } WHERE { }',
      ),
      bindings,
    );

    const [single, union] = result.where.patterns;
    expect(single).toMatchObject({
      subType: 'values',
      values: [{ dataset: { value: 'http://example.org/dataset' } }],
    });
    expect(union.subType).toBe('union');
    const branches = (union as unknown as { patterns: PatternGroup[] })
      .patterns;
    expect(branches.map((branch) => branch.patterns[0])).toMatchObject([
      { subType: 'values', values: [{}, {}] },
      { subType: 'values', values: [{}, {}] },
    ]);
    expect(() => parser.parse(generator.generate(result))).not.toThrow();
  });

  describe('multi-valued groups the query depends on', () => {
    const types = [{ type: literal('A') }, { type: literal('B') }];

    function patternsOf(sparql: string, groups: DatasetBindings = bindings) {
      return injectDatasetBindings(parseConstruct(sparql), groups).where
        .patterns;
    }

    it('joins groups used in the WHERE clause', () => {
      const generated = inject(
        'CONSTRUCT { ?s a ?c } WHERE { ?s <urn:l> ?datasetLanguage ; <urn:n> ?datasetPublisherName }',
      );

      expect(generated).not.toContain('UNION');
      expect(generated).toContain('"nl"');
      expect(generated).toContain('"Naam"@nl');
    });

    it('joins a group used in a FILTER with one used only in the template', () => {
      const generated = inject(
        'CONSTRUCT { ?s <urn:n> ?datasetPublisherName } WHERE { ?s <urn:l> ?l FILTER(?l = ?datasetLanguage) }',
      );

      expect(generated).not.toContain('UNION');
      expect(generated).toContain('"nl"');
      expect(generated).toContain('"Naam"@nl');
    });

    it('counts a variable in a sub-SELECT projection as used in the WHERE clause', () => {
      const generated = inject(
        'CONSTRUCT { ?s <urn:n> ?datasetPublisherName } WHERE { { SELECT ?s ?datasetLanguage { ?s <urn:l> ?datasetLanguage } } }',
      );

      expect(generated).not.toContain('UNION');
      expect(generated).toContain('"nl"');
      expect(generated).toContain('"Naam"@nl');
    });

    it('joins groups a SELECT references, as it has no template', () => {
      const select = parser.parse(
        'SELECT ?s WHERE { ?s <urn:l> ?datasetLanguage ; <urn:n> ?datasetPublisherName }',
      ) as QuerySelect;

      const generated = generator.generate(
        injectDatasetBindings(select, bindings),
      );

      expect(generated).not.toContain('UNION');
      expect(generated).toContain('"nl"');
      expect(generated).toContain('"Naam"@nl');
    });

    it('keeps the other groups in UNION branches when one must be joined', () => {
      const [language, union] = patternsOf(
        'CONSTRUCT { ?s <urn:n> ?datasetPublisherName . ?s <urn:t> ?type } WHERE { ?s <urn:l> ?datasetLanguage }',
        [[dataset], languages, publisherNames, types],
      );

      expect(language).toMatchObject({
        subType: 'values',
        variables: [{ value: 'datasetLanguage' }],
      });
      expect(union.subType).toBe('union');
    });

    it('joins only the groups that share a template triple', () => {
      const [names, nameTypes, languageValues] = patternsOf(
        'CONSTRUCT { ?s <urn:l> ?datasetLanguage . ?datasetPublisherName <urn:t> ?type } WHERE { ?s a ?c }',
        [[dataset], languages, publisherNames, types],
      );

      expect(names).toMatchObject({
        variables: [{ value: 'datasetPublisherName' }],
      });
      expect(nameTypes).toMatchObject({ variables: [{ value: 'type' }] });
      expect(languageValues).toMatchObject({
        subType: 'values',
        variables: [{ value: 'datasetLanguage' }],
      });
    });
  });

  it('uses plain VALUES when only one multi-valued group is referenced', () => {
    const generated = inject(
      'CONSTRUCT { ?s <urn:n> ?datasetPublisherName } WHERE { ?s a ?c }',
    );

    expect(generated).not.toContain('UNION');
    expect(generated).toContain('"Naam"@nl');
    expect(generated).toContain('"Name"@en');
  });

  it.each([
    [
      'are equal for the referenced variables',
      'CONSTRUCT { ?s <urn:a> ?a } WHERE { ?s a ?c }',
      [
        { a: literal('1'), b: literal('x') },
        { a: literal('1'), b: literal('y') },
      ],
    ],
    [
      'bind the same terms in a different order',
      'CONSTRUCT { ?s <urn:a> ?a ; <urn:b> ?b } WHERE { ?s a ?c }',
      [
        { a: literal('1'), b: literal('2') },
        { b: literal('2'), a: literal('1') },
      ],
    ],
  ])('collapses rows that %s', (_description, sparql, rows) => {
    const result = injectDatasetBindings(parseConstruct(sparql), [rows]);

    expect((result.where.patterns[0] as PatternValues).values).toHaveLength(1);
  });

  it('keeps every variable of rows that bind different variables', () => {
    const result = injectDatasetBindings(
      parseConstruct(
        'CONSTRUCT { ?s <urn:a> ?a ; <urn:b> ?b } WHERE { ?s a ?c }',
      ),
      [[{ a: literal('1') }, { b: literal('2') }]],
    );

    expect(
      (result.where.patterns[0] as PatternValues).variables.map(
        (variable) => variable.value,
      ),
    ).toEqual(['a', 'b']);
    expect(() => parser.parse(generator.generate(result))).not.toThrow();
  });

  it('generates valid SPARQL when the WHERE clause is a bare sub-SELECT', () => {
    const generated = inject(
      'CONSTRUCT { ?dataset <http://example.org/count> ?count } WHERE { SELECT (COUNT(*) AS ?count) { ?s ?p ?o } }',
    );

    expect(() => parser.parse(generated)).not.toThrow();
  });

  it('injects at the outer scope, not into a nested sub-SELECT', () => {
    const query = parseConstruct(
      'CONSTRUCT { ?dataset <http://example.org/p> ?partition } WHERE { { SELECT ?class { ?s a ?class } } BIND(IRI(CONCAT(STR(?dataset), STR(?class))) AS ?partition) }',
    );

    const result = injectDatasetBindings(query, bindings);

    expect(hasValues(result.where.patterns)).toBe(true);
    expect(
      hasValues(findSubSelect(result.where.patterns)!.where.patterns),
    ).toBe(false);
  });
});
