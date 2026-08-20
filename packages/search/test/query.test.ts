import { describe, expect, it } from 'vitest';
import {
  assertValidQuery,
  filterOn,
  filterOperator,
  filterOperatorFor,
  isUnsatisfiable,
  pageForOffset,
  validateQuery,
  type SearchQuery,
} from '../src/query.js';
import { joinGraph, MAX_JOIN_DEPTH } from '../src/join-graph.js';
import {
  defineSearchType,
  searchSchema,
  type SearchType,
} from '../src/schema.js';

describe('filterOperator', () => {
  it('reads the operator off a criterion’s discriminating key', () => {
    expect(filterOperator({ field: 'format', in: ['text/turtle'] })).toBe('in');
    expect(filterOperator({ field: 'size', range: { min: 1 } })).toBe('range');
    expect(filterOperator({ field: 'iiif', is: true })).toBe('is');
  });
});

describe('filterOn', () => {
  it('wraps one criterion as a clause – the ordinary single-field filter', () => {
    expect(filterOn({ field: 'status', in: ['valid'] })).toEqual({
      or: [{ field: 'status', in: ['valid'] }],
    });
  });
});

describe('filterOperatorFor', () => {
  it('maps each field kind to its `where` operator', () => {
    expect(filterOperatorFor('text')).toBeUndefined();
    expect(filterOperatorFor('keyword')).toBe('in');
    expect(filterOperatorFor('reference')).toBe('in');
    expect(filterOperatorFor('integer')).toBe('range');
    expect(filterOperatorFor('number')).toBe('range');
    expect(filterOperatorFor('date')).toBe('range');
    expect(filterOperatorFor('boolean')).toBe('is');
  });
});

describe('isUnsatisfiable', () => {
  const base: SearchQuery = {
    where: [],
    orderBy: [],
    limit: 10,
    offset: 0,
    facets: [],
    locale: 'nl',
  };

  it('holds only for an empty `id` membership – the request for no document', () => {
    expect(
      isUnsatisfiable({ ...base, where: [{ or: [{ field: 'id', in: [] }] }] }),
    ).toBe(true);
    // A non-empty lookup asks for something.
    expect(
      isUnsatisfiable({
        ...base,
        where: [{ or: [{ field: 'id', in: ['urn:a'] }] }],
      }),
    ).toBe(false);
    // A value field's empty membership stays a no-op: no values means no
    // constraint (a facet UI with nothing selected), not "no documents".
    expect(
      isUnsatisfiable({
        ...base,
        where: [{ or: [{ field: 'status', in: [] }] }],
      }),
    ).toBe(false);
    // Other operators on `id` are already an operator-mismatch, not this.
    expect(
      isUnsatisfiable({
        ...base,
        where: [{ or: [{ field: 'id', is: true }] }],
      }),
    ).toBe(false);
    // A clause pairing `id` WITH a value field is a disjunction that happens to
    // include identity, not an enumeration of wanted documents – so the
    // identity reading does not apply and it stays a vacuous no-op.
    expect(
      isUnsatisfiable({
        ...base,
        where: [
          {
            or: [
              { field: 'id', in: [] },
              { field: 'creator', in: [] },
            ],
          },
        ],
      }),
    ).toBe(false);
    expect(isUnsatisfiable(base)).toBe(false);
  });
});

describe('validateQuery', () => {
  const searchType: SearchType = {
    name: 'Dataset',
    class: 'http://www.w3.org/ns/dcat#Dataset',
    fields: [
      { name: 'status', kind: 'keyword', facetable: true, filterable: true },
      { name: 'size', kind: 'integer', filterable: true },
      { name: 'license', kind: 'keyword' }, // declared, but no roles opted into
      { name: 'statusRank', kind: 'integer', sortable: true },
      { name: 'creator', kind: 'reference', filterable: true },
      { name: 'about', kind: 'reference', filterable: true },
      {
        name: 'dataset',
        kind: 'reference',
        output: true,
        ref: { strategy: 'lookup', target: 'Dataset' },
      },
      // Makes the type its own resolvable lookup target: a label to resolve,
      // and one more output field for a projection to name.
      {
        name: 'label',
        kind: 'text',
        locales: ['nl'],
        output: true,
        searchable: { weight: 1 },
      },
    ],
  };
  const schema = searchSchema(searchType);
  const base: SearchQuery = {
    where: [],
    orderBy: [],
    limit: 10,
    offset: 0,
    facets: [],
    locale: 'nl',
  };

  it('accepts a structurally valid query', () => {
    expect(
      validateQuery(
        {
          ...base,
          where: [
            { or: [{ field: 'status', in: ['valid'] }] },
            { or: [{ field: 'size', range: { min: 1 } }] },
          ],
          facets: ['status'],
          orderBy: [
            { field: 'relevance', direction: 'desc' },
            // Declared but not `sortable`: allowed – `sortable` means publicly
            // selectable, and deployment policy may sort on a private tie-break.
            { field: 'statusRank', direction: 'asc' },
          ],
        },
        searchType,
        schema,
      ),
    ).toEqual([]);
  });

  it('accepts vacuous clauses: they are no-ops, not structural issues', () => {
    expect(
      validateQuery(
        {
          ...base,
          where: [
            { or: [{ field: 'status', in: [] }] },
            { or: [{ field: 'size', range: {} }] },
          ],
        },
        searchType,
        schema,
      ),
    ).toEqual([]);
  });

  it('flags every structurally invalid part', () => {
    const issues = validateQuery(
      {
        ...base,
        where: [
          { or: [{ field: 'nonexistent', in: ['x'] }] },
          { or: [{ field: 'license', in: ['MIT'] }] },
          { or: [{ field: 'status', range: { min: 1 } }] },
        ],
        facets: ['nonexistent', 'size'],
        orderBy: [{ field: 'nonexistent', direction: 'asc' }],
      },
      searchType,
      schema,
    );
    expect(issues).toEqual([
      { part: 'where', field: 'nonexistent', reason: 'unknown-field' },
      { part: 'where', field: 'license', reason: 'not-filterable' },
      { part: 'where', field: 'status', reason: 'operator-mismatch' },
      { part: 'facets', field: 'nonexistent', reason: 'unknown-field' },
      { part: 'facets', field: 'size', reason: 'not-facetable' },
      { part: 'orderBy', field: 'nonexistent', reason: 'unknown-field' },
    ]);
  });

  it('accepts a projection at every level, fields and all', () => {
    // The type is its own lookup target, so one declaration nests as deep as
    // the test needs.
    expect(
      validateQuery(
        {
          ...base,
          resolve: {
            dataset: {
              fields: ['label'],
              // No `fields`: the level resolves its target's label alone.
              resolve: { dataset: {} },
            },
          },
        },
        searchType,
        schema,
      ),
    ).toEqual([]);
  });

  it('reports a projection on an undeclared or non-lookup field', () => {
    expect(
      validateQuery(
        { ...base, resolve: { nonexistent: {}, creator: {}, status: {} } },
        searchType,
        schema,
      ),
    ).toEqual([
      { part: 'resolve', field: 'nonexistent', reason: 'unknown-field' },
      // Declared references, but neither is a lookup: nothing to resolve from.
      { part: 'resolve', field: 'creator', reason: 'not-resolvable' },
      { part: 'resolve', field: 'status', reason: 'not-resolvable' },
    ]);
  });

  it('reports a lookup whose target this schema does not hold', () => {
    // Only reachable across schemas: searchSchema rejects an unresolvable
    // target at declaration time, so this is a query built against another one.
    const foreignType: SearchType = {
      ...searchType,
      fields: [
        {
          name: 'dataset',
          kind: 'reference',
          output: true,
          ref: { strategy: 'lookup', target: 'Elsewhere' },
        },
      ],
    };
    expect(
      validateQuery({ ...base, resolve: { dataset: {} } }, foreignType, schema),
    ).toEqual([
      { part: 'resolve', field: 'dataset', reason: 'not-resolvable' },
    ]);
  });

  it('reports a field the target does not serve, at any depth', () => {
    expect(
      validateQuery(
        {
          ...base,
          resolve: {
            dataset: {
              // `nonexistent` is undeclared; `license` is declared but carries
              // no `output` role, so the target cannot serve it either.
              fields: ['nonexistent', 'license'],
              resolve: { dataset: { fields: ['nonexistent'] } },
            },
          },
        },
        searchType,
        schema,
      ),
    ).toEqual([
      {
        part: 'resolve',
        field: 'dataset.nonexistent',
        reason: 'unknown-field',
      },
      { part: 'resolve', field: 'dataset.license', reason: 'unknown-field' },
      {
        part: 'resolve',
        field: 'dataset.nonexistent',
        reason: 'unknown-field',
      },
    ]);
  });

  it('accepts `id`, which no type declares but every type carries', () => {
    expect(
      validateQuery(
        {
          ...base,
          where: [{ or: [{ field: 'id', in: ['https://example.org/1'] }] }],
        },
        searchType,
        schema,
      ),
    ).toEqual([]);
  });

  it('rejects a non-membership operator on `id`: an IRI has no range', () => {
    expect(
      validateQuery(
        { ...base, where: [{ or: [{ field: 'id', range: { min: 1 } }] }] },
        searchType,
        schema,
      ),
    ).toEqual([{ part: 'where', field: 'id', reason: 'operator-mismatch' }]);
  });

  it('accepts a disjunction over several fields – the cross-field clause', () => {
    const iri = 'https://example.org/vg';
    expect(
      validateQuery(
        {
          ...base,
          where: [
            {
              or: [
                { field: 'id', in: [iri] },
                { field: 'creator', in: [iri] },
                { field: 'about', in: [iri] },
              ],
            },
          ],
        },
        searchType,
        schema,
      ),
    ).toEqual([]);
  });

  it('checks every criterion of a clause, reporting one issue each', () => {
    expect(
      validateQuery(
        {
          ...base,
          where: [
            {
              or: [
                { field: 'creator', in: ['x'] },
                { field: 'nonexistent', in: ['x'] },
                { field: 'license', in: ['x'] },
              ],
            },
          ],
        },
        searchType,
        schema,
      ),
    ).toEqual([
      { part: 'where', field: 'nonexistent', reason: 'unknown-field' },
      { part: 'where', field: 'license', reason: 'not-filterable' },
    ]);
  });

  it('lets one clause mix kinds: each criterion is matched to its own field', () => {
    // `creator` takes `in` and `size` takes `range`. Because a criterion carries
    // its own operator, a disjunction over both is well-formed – “made by this
    // person OR larger than 100”.
    expect(
      validateQuery(
        {
          ...base,
          where: [
            {
              or: [
                { field: 'creator', in: ['x'] },
                { field: 'size', range: { min: 100 } },
              ],
            },
          ],
        },
        searchType,
        schema,
      ),
    ).toEqual([]);
    // …while an operator that does not match ITS OWN field is still rejected.
    expect(
      validateQuery(
        { ...base, where: [{ or: [{ field: 'size', in: ['x'] }] }] },
        searchType,
        schema,
      ),
    ).toEqual([{ part: 'where', field: 'size', reason: 'operator-mismatch' }]);
  });

  it('accepts several criteria on one field – the same-field disjunction', () => {
    // Two ranges on one field is the case a value list cannot express:
    // “smaller than 10 or larger than 100”.
    expect(
      validateQuery(
        {
          ...base,
          where: [
            {
              or: [
                { field: 'size', range: { max: 10 } },
                { field: 'size', range: { min: 100 } },
              ],
            },
          ],
        },
        searchType,
        schema,
      ),
    ).toEqual([]);
  });

  it('treats a clause with no criteria as vacuous, not invalid', () => {
    // Like an empty `in` or a boundless `range`: it constrains nothing, so a
    // compiler skips it as a no-op rather than the query being rejected.
    expect(
      validateQuery({ ...base, where: [{ or: [] }] }, searchType, schema),
    ).toEqual([]);
  });

  describe('a criterion carrying a join path', () => {
    // A three-type chain, so a path of every allowed depth is expressible.
    const label = (name: string, fields: SearchType['fields'] = []) =>
      defineSearchType({
        name,
        class: `https://example.org/${name}`,
        fields: [
          {
            name: 'label',
            kind: 'text',
            locales: ['nl'],
            output: true,
            searchable: { weight: 5 },
          },
          { name: 'country', kind: 'keyword', filterable: true },
          { name: 'note', kind: 'keyword' },
          ...fields,
        ],
      });
    const joinable = (name: string, source: string) =>
      ({
        name,
        kind: 'reference',
        filterable: true,
        labelSource: source,
        joinable: true,
      }) as const;
    const publisher = label('Publisher');
    const dataset = label('Dataset', [joinable('publisher', 'Publisher')]);
    const work = label('CreativeWork', [joinable('dataset', 'Dataset')]);
    const joinedSchema = searchSchema(publisher, dataset, work);
    const joins = joinGraph(joinedSchema);

    it('validates the leaf against the type the path reaches', () => {
      expect(
        validateQuery(
          {
            ...base,
            where: [
              {
                or: [
                  { on: ['dataset', 'publisher'], field: 'id', in: ['urn:x'] },
                  { on: ['dataset'], field: 'country', in: ['NL'] },
                ],
              },
            ],
          },
          work,
          joinedSchema,
          joins,
        ),
      ).toEqual([]);
    });

    it('reports the leaf’s own issues under the full path', () => {
      expect(
        validateQuery(
          {
            ...base,
            where: [
              // `note` is declared on Publisher but opts into no role, and
              // `country` is a keyword, so a range mismatches its kind.
              { or: [{ on: ['dataset', 'publisher'], field: 'note', in: [] }] },
              { or: [{ on: ['dataset'], field: 'country', range: {} }] },
              { or: [{ on: ['dataset'], field: 'nonesuch', in: [] }] },
            ],
          },
          work,
          joinedSchema,
          joins,
        ),
      ).toEqual([
        {
          part: 'where',
          field: 'dataset.publisher.note',
          reason: 'not-filterable',
        },
        {
          part: 'where',
          field: 'dataset.country',
          reason: 'operator-mismatch',
        },
        { part: 'where', field: 'dataset.nonesuch', reason: 'unknown-field' },
      ]);
    });

    it('rejects a path an `id` criterion uses with the wrong operator', () => {
      expect(
        validateQuery(
          {
            ...base,
            where: [{ or: [{ on: ['dataset'], field: 'id', is: true }] }],
          },
          work,
          joinedSchema,
          joins,
        ),
      ).toEqual([
        { part: 'where', field: 'dataset.id', reason: 'operator-mismatch' },
      ]);
    });

    it('caps the depth, in the IR rather than in a surface', () => {
      const tooDeep = Array.from(
        { length: MAX_JOIN_DEPTH + 1 },
        () => 'dataset',
      );
      expect(
        validateQuery(
          {
            ...base,
            where: [{ or: [{ on: tooDeep, field: 'id', in: ['x'] }] }],
          },
          work,
          joinedSchema,
          joins,
        ),
      ).toEqual([
        {
          part: 'where',
          field: `${tooDeep.join('.')}.id`,
          reason: 'join-too-deep',
        },
      ]);
    });

    it('rejects a path that does not resolve, and one with no graph to resolve it', () => {
      expect(
        validateQuery(
          // `label` is a field, but not a joinable reference.
          {
            ...base,
            where: [{ or: [{ on: ['label'], field: 'id', in: ['x'] }] }],
          },
          work,
          joinedSchema,
          joins,
        ),
      ).toEqual([{ part: 'where', field: 'label.id', reason: 'unknown-join' }]);
      // A joined criterion validated without a join graph is an issue, never a
      // silently unchecked filter.
      expect(
        validateQuery(
          {
            ...base,
            where: [{ or: [{ on: ['dataset'], field: 'id', in: ['x'] }] }],
          },
          work,
          joinedSchema,
        ),
      ).toEqual([
        { part: 'where', field: 'dataset.id', reason: 'unknown-join' },
      ]);
    });

    it('treats an empty path as no join at all', () => {
      expect(
        validateQuery(
          { ...base, where: [{ or: [{ on: [], field: 'label', in: ['x'] }] }] },
          work,
          joinedSchema,
          joins,
        ),
      ).toEqual([{ part: 'where', field: 'label', reason: 'not-filterable' }]);
    });
  });

  it('assertValidQuery names the type and every issue', () => {
    expect(() =>
      assertValidQuery(
        { ...base, where: [{ or: [{ field: 'nonexistent', in: ['x'] }] }] },
        searchType,
        schema,
      ),
    ).toThrow(
      'Invalid search query for “Dataset”: where: “nonexistent” (unknown-field).',
    );
    expect(() => assertValidQuery(base, searchType, schema)).not.toThrow();
  });
});

describe('pageForOffset', () => {
  it('maps an offset to its 1-based page', () => {
    expect(pageForOffset(0, 20)).toBe(1);
    expect(pageForOffset(40, 20)).toBe(3);
  });

  it('pins a facet-only query (limit 0) to page 1 instead of dividing by zero', () => {
    expect(pageForOffset(0, 0)).toBe(1);
  });
});
