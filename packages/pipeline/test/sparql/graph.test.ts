import { describe, it, expect } from 'vitest';
import { Parser } from '@traqula/parser-sparql-1-1';
import type { QueryConstruct } from '@traqula/rules-sparql-1-1';
import { withDefaultGraph } from '../../src/sparql/graph.js';

const parser = new Parser();

function parseConstruct(sparql: string): QueryConstruct {
  return parser.parse(sparql) as QueryConstruct;
}

describe('withDefaultGraph', () => {
  it('sets datasets to the given graph IRI', () => {
    const query = parseConstruct('CONSTRUCT { ?s ?p ?o } WHERE { ?s ?p ?o }');

    withDefaultGraph(query, 'http://example.org/graph');

    expect(query.datasets.clauses).toEqual([
      {
        clauseType: 'default',
        value: expect.objectContaining({
          type: 'term',
          subType: 'namedNode',
          value: 'http://example.org/graph',
        }),
      },
    ]);
  });

  it('scopes a SELECT the same way, for an item selector', () => {
    const query = parser.parse(
      'SELECT ?s WHERE { ?s ?p ?o }',
    ) as unknown as QueryConstruct;

    withDefaultGraph(query, 'http://example.org/graph');

    expect(query.datasets.clauses[0]).toMatchObject({
      clauseType: 'default',
      value: expect.objectContaining({ value: 'http://example.org/graph' }),
    });
  });

  it('rejects a graph IRI that would break out of the IRI reference', () => {
    // A `namedGraph` is a plain string, typically carried in from third-party
    // registry data; unchecked, one of these rewrites the query around it.
    for (const unsafe of [
      'http://example.org/a>b',
      'http://example.org/a b',
      'http://example.org/g> WHERE { ?s ?p ?o } #',
    ]) {
      const query = parseConstruct('CONSTRUCT { ?s ?p ?o } WHERE { ?s ?p ?o }');
      expect(() => withDefaultGraph(query, unsafe)).toThrow(
        /unsafe characters/,
      );
    }
  });

  it('replaces an existing FROM clause', () => {
    const query = parseConstruct(
      'CONSTRUCT { ?s ?p ?o } FROM <http://old.org/graph> WHERE { ?s ?p ?o }',
    );

    withDefaultGraph(query, 'http://new.org/graph');

    expect(query.datasets.clauses).toHaveLength(1);
    expect(query.datasets.clauses[0]).toMatchObject({
      clauseType: 'default',
      value: expect.objectContaining({
        type: 'term',
        subType: 'namedNode',
        value: 'http://new.org/graph',
      }),
    });
  });
});
