import { describe, expect, it } from 'vitest';
import type { SearchQuery, SearchType } from '@lde/search';
import { buildSearchParams } from '../src/query-compiler.js';

const schema: SearchType = {
  name: 'Dataset',
  class: 'http://www.w3.org/ns/dcat#Dataset',
  fields: [
    {
      name: 'title',
      path: 'http://purl.org/dc/terms/title',
      kind: 'text',
      locales: ['nl', 'en'],
      output: true,
      searchable: { weight: 5 },
      sortable: true,
    },
    {
      name: 'keyword',
      path: 'http://www.w3.org/ns/dcat#keyword',
      kind: 'keyword',
      array: true,
      facetable: true,
      filterable: true,
      searchable: { weight: 1 },
    },
    {
      name: 'format',
      kind: 'keyword',
      array: true,
      facetable: true,
      filterable: true,
    },
    // Filter-only, non-facet (tokenized) → exact `:=` membership.
    { name: 'catalog', kind: 'keyword', array: true, filterable: true },
    { name: 'status', kind: 'keyword', facetable: true, filterable: true },
    {
      name: 'size',
      kind: 'integer',
      filterable: true,
      sortable: true,
      facetable: true,
      // Half-open `[min, max)` bins; the last is open-ended (no upper bound).
      facetRanges: [
        { key: '0', min: 1, max: 10 },
        { key: '1', min: 10, max: 100 },
        { key: '2', min: 100 },
      ],
    },
    { name: 'iiif', kind: 'boolean', filterable: true, facetable: true },
    { name: 'datePosted', kind: 'date', filterable: true, sortable: true },
  ],
};

const base: SearchQuery = {
  where: [],
  orderBy: [],
  limit: 20,
  offset: 0,
  facets: [],
  locale: 'nl',
};

describe('buildSearchParams', () => {
  it('browses with a match-all q and the weighted query_by fields', () => {
    const params = buildSearchParams(base, schema);
    expect(params.q).toBe('*');
    expect(params.query_by).toBe(
      'title_search_nl,title_search_en,keyword_search',
    );
    expect(params.per_page).toBe(20);
    expect(params.page).toBe(1);
    expect(params.filter_by).toBeUndefined();
    expect(params.sort_by).toBeUndefined();
  });

  it('folds the query text and boosts the active locale in query_by_weights', () => {
    expect(
      buildSearchParams({ ...base, text: 'Kaart', locale: 'nl' }, schema),
    ).toMatchObject({ q: 'kaart', query_by_weights: '5,4,1' });
    expect(
      buildSearchParams({ ...base, text: 'Kaart', locale: 'en' }, schema)
        .query_by_weights,
    ).toBe('4,5,1');
  });

  it('maps offset/limit to numbered pages', () => {
    expect(
      buildSearchParams({ ...base, offset: 40, limit: 20 }, schema).page,
    ).toBe(3);
  });

  it('compiles where clauses, with exact membership for non-facet fields', () => {
    const params = buildSearchParams(
      {
        ...base,
        where: [
          { or: [{ field: 'status', in: ['valid'] }] },
          { or: [{ field: 'keyword', in: ['kaarten', 'atlas'] }] },
          { or: [{ field: 'catalog', in: ['urn:cat'] }] },
          { or: [{ field: 'format', in: ['text/turtle', 'group:rdf'] }] },
          { or: [{ field: 'size', range: { min: 1, max: 10 } }] },
          { or: [{ field: 'iiif', is: true }] },
        ],
      },
      schema,
    );
    expect(params.filter_by).toBe(
      'status:[`valid`] && ' +
        'keyword:[`kaarten`,`atlas`] && ' +
        'catalog:=[`urn:cat`] && ' +
        'format:[`text/turtle`,`group:rdf`] && ' +
        'size:[1..10] && ' +
        'iiif:=true',
    );
  });

  it('compiles a disjunction to one parenthesised `||` group', () => {
    // The whole point: one engine round-trip, not one query per field. Each
    // criterion keeps its OWN field's membership operator – `catalog` is
    // non-facet so it stays exact `:=`, while the facet fields use `:` – and
    // the parentheses keep the `||` binding tighter than the `&&` between
    // clauses.
    const params = buildSearchParams(
      {
        ...base,
        where: [
          {
            or: [
              { field: 'id', in: ['urn:vg'] },
              { field: 'keyword', in: ['urn:vg'] },
              { field: 'catalog', in: ['urn:vg'] },
            ],
          },
          { or: [{ field: 'status', in: ['valid'] }] },
        ],
      },
      schema,
    );
    expect(params.filter_by).toBe(
      '(id:=[`urn:vg`] || keyword:[`urn:vg`] || catalog:=[`urn:vg`])' +
        ' && status:[`valid`]',
    );
  });

  it('mixes operators inside one disjunction, each on its own field', () => {
    // A criterion carries its own operator, so a clause may range over a
    // keyword and a numeric field at once – and over ONE field twice, which is
    // the only way to say “smaller than 10 or larger than 100”.
    expect(
      buildSearchParams(
        {
          ...base,
          where: [
            {
              or: [
                { field: 'size', range: { max: 10 } },
                { field: 'size', range: { min: 100 } },
                { field: 'iiif', is: true },
              ],
            },
          ],
        },
        schema,
      ).filter_by,
    ).toBe('(size:<=10 || size:>=100 || iiif:=true)');
  });

  it('leaves a one-criterion clause unparenthesised', () => {
    // The ordinary single-field filter, which must compile exactly as it did
    // before clauses could hold more than one criterion.
    expect(
      buildSearchParams(
        { ...base, where: [{ or: [{ field: 'status', in: ['valid'] }] }] },
        schema,
      ).filter_by,
    ).toBe('status:[`valid`]');
  });

  it('drops a non-compiling criterion, keeping the rest of the disjunction', () => {
    // `nonexistent` contributes no term, but the caller still asked about
    // `keyword`, so the clause survives on the criteria that do compile.
    expect(
      buildSearchParams(
        {
          ...base,
          where: [
            {
              or: [
                { field: 'keyword', in: ['atlas'] },
                { field: 'nonexistent', in: ['atlas'] },
              ],
            },
          ],
        },
        schema,
      ).filter_by,
    ).toBe('keyword:[`atlas`]');
  });

  it('voids the whole clause when an alternative states no constraint', () => {
    // An empty `in` on a value field means “no constraint” – true – and
    // `true || X` is true, so the clause constrains nothing. Dropping only that
    // criterion would NARROW the result to its siblings, turning an unset
    // filter (a facet UI with nothing selected) into an active one.
    const ignored: unknown[] = [];
    const params = buildSearchParams(
      {
        ...base,
        where: [
          {
            or: [
              { field: 'status', in: [] },
              { field: 'keyword', in: ['atlas'] },
            ],
          },
          { or: [{ field: 'format', in: ['text/turtle'] }] },
        ],
      },
      schema,
      { onIgnoredFilter: (filter) => ignored.push(filter) },
    );
    // Only the untouched sibling clause survives – NOT `keyword:[atlas]`.
    expect(params.filter_by).toBe('format:[`text/turtle`]');
    expect(ignored).toHaveLength(1);
  });

  it('drops an unsatisfiable alternative, keeping its siblings', () => {
    // An empty `id` membership is the request for NO document – false – and
    // `false || X` is X, so unlike a vacuous value filter it drops out and the
    // rest of the disjunction still stands.
    expect(
      buildSearchParams(
        {
          ...base,
          where: [
            {
              or: [
                { field: 'id', in: [] },
                { field: 'keyword', in: ['atlas'] },
              ],
            },
          ],
        },
        schema,
      ).filter_by,
    ).toBe('keyword:[`atlas`]');
  });

  it('voids a clause whose alternative range has no usable bound', () => {
    expect(
      buildSearchParams(
        {
          ...base,
          where: [
            {
              or: [
                { field: 'size', range: {} },
                { field: 'keyword', in: ['atlas'] },
              ],
            },
          ],
        },
        schema,
      ).filter_by,
    ).toBeUndefined();
  });

  it('ignores a clause when no criterion compiles', () => {
    const ignored: unknown[] = [];
    const clause = {
      or: [
        { field: 'nope', in: ['x'] },
        { field: 'alsoNope', in: ['x'] },
      ],
    };
    const params = buildSearchParams({ ...base, where: [clause] }, schema, {
      onIgnoredFilter: (filter) => ignored.push(filter),
    });
    expect(params.filter_by).toBeUndefined();
    expect(ignored).toEqual([clause]);
  });

  it('compiles an `id` clause to exact membership on the document key', () => {
    // `id` is declared by no type: it is the document's IRI, filtered by the
    // same exact clause label resolution uses. Backtick-wrapped, so the IRI's
    // `:` and `/` stay literal.
    const params = buildSearchParams(
      {
        ...base,
        where: [
          { or: [{ field: 'id', in: ['https://id.example.org/a', 'urn:b'] }] },
          { or: [{ field: 'status', in: ['valid'] }] },
        ],
      },
      schema,
    );
    expect(params.filter_by).toBe(
      'id:=[`https://id.example.org/a`,`urn:b`] && status:[`valid`]',
    );
  });

  it('skips a vacuous or non-membership `id` clause', () => {
    const ignored: unknown[] = [];
    const params = buildSearchParams(
      {
        ...base,
        where: [
          { or: [{ field: 'id', in: [] }] },
          { or: [{ field: 'id', range: { min: 1 } }] },
        ],
      },
      schema,
      { onIgnoredFilter: (filter) => ignored.push(filter) },
    );
    expect(params.filter_by).toBeUndefined();
    expect(ignored).toEqual([
      { or: [{ field: 'id', in: [] }] },
      { or: [{ field: 'id', range: { min: 1 } }] },
    ]);
  });

  it('skips a clause that compiles to nothing and reports it via onIgnoredFilter', () => {
    const ignored: unknown[] = [];
    const params = buildSearchParams(
      {
        ...base,
        where: [
          { or: [{ field: 'status', in: ['valid'] }] }, // fine – kept
          { or: [{ field: 'nonexistent', in: ['x'] }] }, // unknown field
          { or: [{ field: 'keyword', range: { min: 1 } }] }, // operator ≠ field kind
          { or: [{ field: 'status', in: [] }] }, // empty membership
          { or: [{ field: 'size', range: {} }] }, // no usable bound
        ],
      },
      schema,
      { onIgnoredFilter: (filter) => ignored.push(filter) },
    );
    expect(params.filter_by).toBe('status:[`valid`]');
    expect(ignored).toEqual([
      { or: [{ field: 'nonexistent', in: ['x'] }] },
      { or: [{ field: 'keyword', range: { min: 1 } }] },
      { or: [{ field: 'status', in: [] }] },
      { or: [{ field: 'size', range: {} }] },
    ]);
  });

  it('skips a non-compiling clause silently when no onIgnoredFilter is given', () => {
    const params = buildSearchParams(
      { ...base, where: [{ or: [{ field: 'nonexistent', in: ['x'] }] }] },
      schema,
    );
    expect(params.filter_by).toBeUndefined();
  });

  it('compiles a one-sided range bound', () => {
    expect(
      buildSearchParams(
        { ...base, where: [{ or: [{ field: 'size', range: { min: 5 } }] }] },
        schema,
      ).filter_by,
    ).toBe('size:>=5');
    expect(
      buildSearchParams(
        { ...base, where: [{ or: [{ field: 'size', range: { max: 9 } }] }] },
        schema,
      ).filter_by,
    ).toBe('size:<=9');
  });

  it('converts a date field’s ISO bounds to the stored Unix seconds', () => {
    const min = Date.parse('2024-01-01T00:00:00Z') / 1000;
    const max = Date.parse('2025-01-01T00:00:00Z') / 1000;
    expect(
      buildSearchParams(
        {
          ...base,
          where: [
            {
              or: [
                {
                  field: 'datePosted',
                  range: {
                    min: '2024-01-01T00:00:00Z',
                    max: '2025-01-01T00:00:00Z',
                  },
                },
              ],
            },
          ],
        },
        schema,
      ).filter_by,
    ).toBe(`datePosted:[${min}..${max}]`);
    // An unparseable bound is dropped rather than compiled into garbage.
    expect(
      buildSearchParams(
        {
          ...base,
          where: [
            {
              or: [
                {
                  field: 'datePosted',
                  range: { min: 'not-a-date', max: '2025-01-01T00:00:00Z' },
                },
              ],
            },
          ],
        },
        schema,
      ).filter_by,
    ).toBe(`datePosted:<=${max}`);
  });

  it('compiles orderBy: RELEVANCE → _text_match and a localized field → its sort key', () => {
    expect(
      buildSearchParams(
        {
          ...base,
          orderBy: [
            { field: 'relevance', direction: 'desc' },
            { field: 'status_rank', direction: 'asc' },
          ],
        },
        schema,
      ).sort_by,
    ).toBe('_text_match:desc,status_rank:asc');

    expect(
      buildSearchParams(
        {
          ...base,
          locale: 'nl',
          orderBy: [
            { field: 'title', direction: 'asc' },
            { field: 'status_rank', direction: 'asc' },
          ],
        },
        schema,
      ).sort_by,
    ).toBe('title_sort_nl:asc,status_rank:asc');
  });

  it('pins page to 1 for a facet-only (limit:0) query instead of dividing by zero', () => {
    const params = buildSearchParams({ ...base, limit: 0 }, schema);
    expect(params.per_page).toBe(0);
    expect(params.page).toBe(1);
  });

  it('requests facets by their logical field name', () => {
    expect(
      buildSearchParams({ ...base, facets: ['keyword', 'format'] }, schema)
        .facet_by,
    ).toBe('keyword,format');
  });

  it('facets a range field into its declared half-open bins, open ends blank', () => {
    // Typesense range syntax is start-inclusive/end-exclusive, so the declared
    // `[min, max)` bounds pass straight through; the open-ended bin leaves the
    // upper bound blank.
    expect(
      buildSearchParams({ ...base, facets: ['size'] }, schema).facet_by,
    ).toBe('size(0:[1, 10], 1:[10, 100], 2:[100, ])');
  });

  it('mixes range and plain facets in one facet_by clause', () => {
    expect(
      buildSearchParams({ ...base, facets: ['keyword', 'size'] }, schema)
        .facet_by,
    ).toBe('keyword,size(0:[1, 10], 1:[10, 100], 2:[100, ])');
  });

  it('omits max_facet_values by default but sets it when configured', () => {
    expect(
      buildSearchParams({ ...base, facets: ['keyword'] }, schema)
        .max_facet_values,
    ).toBeUndefined();
    expect(
      buildSearchParams({ ...base, facets: ['keyword'] }, schema, {
        maxFacetValues: 250,
      }).max_facet_values,
    ).toBe(250);
  });
});

describe('und locale', () => {
  const undSchema: SearchType = {
    name: 'Doc',
    class: 'urn:example:Doc',
    fields: [
      {
        name: 'title',
        kind: 'text',
        locales: ['nl', 'und'],
        output: true,
        sortable: true,
        searchable: { weight: 5 },
      },
    ],
  };

  it('never demotes the language-neutral und search field', () => {
    const params = buildSearchParams({ ...base, locale: 'en' }, undSchema);
    // Neither locale is active: nl is demoted, und keeps full weight.
    expect(params.query_by).toBe('title_search_nl,title_search_und');
    expect(params.query_by_weights).toBe('4,5');
  });

  it('falls back to the first declared locale for sorting', () => {
    const params = buildSearchParams(
      {
        ...base,
        locale: 'en',
        orderBy: [{ field: 'title', direction: 'asc' }],
      },
      undSchema,
    );
    // en is not declared: sort on the first locale's key rather than a
    // nonexistent physical field.
    expect(params.sort_by).toBe('title_sort_nl:asc');
  });
});
