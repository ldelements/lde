import { describe, expect, it } from 'vitest';
import { projectDocument } from '../src/project.js';
import {
  facetSearches,
  validateQuery,
  type SearchQuery,
} from '../src/query.js';
import { defineSearchType, searchSchema } from '../src/schema.js';
import { compileStoredFilters } from '../src/stored-filter.js';

const SCHEMA_ORG = 'https://schema.org/';
const AUTHORITY = 'https://authority.example/term/';
const SELECTION = 'https://ex/selection/pottery';
const alias = (type: string, field: string) => `urn:lde:${type}/${field}`;

/** Keyed on what a term is aligned to, so two publishers’ terms for one
 *  concept are one document – and a reference to either stores that key. */
const term = defineSearchType({
  name: 'Term',
  class: `${SCHEMA_ORG}DefinedTerm`,
  labelField: 'name',
  key: { field: '_sameAs' },
  fields: [
    {
      name: 'name',
      kind: 'text',
      path: `<${SCHEMA_ORG}name>`,
      locales: ['und'],
      output: true,
      searchable: { weight: 1 },
    },
    {
      name: '_sameAs',
      kind: 'reference',
      array: true,
      path: `<${SCHEMA_ORG}sameAs>`,
    },
  ],
});

const work = defineSearchType({
  name: 'CreativeWork',
  class: `${SCHEMA_ORG}CreativeWork`,
  labelField: 'name',
  fields: [
    {
      name: 'about',
      kind: 'reference',
      array: true,
      path: `<${SCHEMA_ORG}about>`,
      filterable: true,
      facetable: true,
      ref: { strategy: 'lookup', target: 'Term' },
    },
    {
      name: 'genre',
      kind: 'keyword',
      path: `<${SCHEMA_ORG}genre>`,
      filterable: true,
    },
    {
      name: 'name',
      kind: 'text',
      path: `<${SCHEMA_ORG}name>`,
      locales: ['und'],
      output: true,
      searchable: { weight: 1 },
    },
    {
      name: 'media',
      kind: 'reference',
      path: `<${SCHEMA_ORG}associatedMedia>`,
      output: true,
      ref: { typeName: 'MediaObject', strategy: 'inline' },
    },
    { name: 'dataset', kind: 'keyword', from: 'dataset', filterable: true },
    // Filled by a writer, not by the projection.
    { name: 'status', kind: 'keyword', filterable: true },
    {
      name: 'subject',
      kind: 'reference',
      array: true,
      path: `<${SCHEMA_ORG}keywords>`,
      output: true,
      ref: { strategy: 'lookup', target: 'Term', local: true },
    },
    {
      name: 'selections',
      kind: 'reference',
      array: true,
      from: 'matchedFilters',
      filterable: true,
    },
    {
      name: 'material',
      kind: 'keyword',
      path: `<${SCHEMA_ORG}material>`,
      filterable: true,
    },
  ],
});

const media = defineSearchType({
  name: 'MediaObject',
  fields: [
    {
      name: 'contentUrl',
      kind: 'keyword',
      path: `<${SCHEMA_ORG}contentUrl>`,
      output: true,
    },
  ],
});

/** A root type with nowhere to put a filter’s value. */
const plain = defineSearchType({
  name: 'Plain',
  class: `${SCHEMA_ORG}Thing`,
  fields: [
    {
      name: 'genre',
      kind: 'keyword',
      path: `<${SCHEMA_ORG}genre>`,
      output: true,
    },
  ],
});

const schema = searchSchema(term, work, media, plain);

/** A work about a publisher’s own term, aligned to an authority’s. */
const workAbout = (...authorityTerms: string[]) => ({
  '@id': 'https://ex/work/1',
  [alias('CreativeWork', 'about')]: authorityTerms.map((iri, index) => ({
    '@id': `https://publisher.example/term/${index}`,
    [alias('Term', '_sameAs')]: [{ '@id': iri }],
  })),
  [alias('CreativeWork', 'genre')]: ['plate'],
});

const about = (op: string, ...terms: string[]) => ({
  op,
  args: [{ property: 'about' }, terms],
});

function project(node: Record<string, unknown>, filter: unknown) {
  return projectDocument(node, work, schema, {
    matchedFilters: compileStoredFilters(schema, [
      { type: 'CreativeWork', value: SELECTION, filter },
    ]),
  });
}

describe('stored filters', () => {
  it('marks a document that matches on the key its reference stores', () => {
    // The filter names the authority’s IRI; the graph names the publisher’s own
    // term. The field holds the key by the time the filter reads it.
    const document = project(
      workAbout(`${AUTHORITY}pottery`),
      about('a_contains', `${AUTHORITY}pottery`),
    );

    expect(document.about).toEqual([`${AUTHORITY}pottery`]);
    expect(document.selections).toEqual([SELECTION]);
  });

  it('leaves the field absent on a document that matches nothing', () => {
    const document = project(
      workAbout(`${AUTHORITY}glass`),
      about('a_contains', `${AUTHORITY}pottery`),
    );

    expect(document).not.toHaveProperty('selections');
  });

  it('leaves the field absent without stored filters', () => {
    const document = projectDocument(
      workAbout(`${AUTHORITY}pottery`),
      work,
      schema,
    );

    expect(document).not.toHaveProperty('selections');
  });

  it('wants every value for a_contains and any value for a_overlaps', () => {
    const node = workAbout(`${AUTHORITY}pottery`);
    const both = [`${AUTHORITY}pottery`, `${AUTHORITY}glass`];

    expect(project(node, about('a_contains', ...both))).not.toHaveProperty(
      'selections',
    );
    expect(project(node, about('a_overlaps', ...both)).selections).toEqual([
      SELECTION,
    ]);
  });

  it('compares a single-valued field with = and in', () => {
    const node = workAbout();
    const genre = (op: string, value: unknown) => ({
      op,
      args: [{ property: 'genre' }, value],
    });

    expect(project(node, genre('=', 'plate')).selections).toEqual([SELECTION]);
    expect(project(node, genre('=', 'cup'))).not.toHaveProperty('selections');
    expect(project(node, genre('in', ['cup', 'plate'])).selections).toEqual([
      SELECTION,
    ]);
  });

  it('reads a field the run fills, such as the dataset', () => {
    const matcher = compileStoredFilters(schema, [
      {
        type: 'CreativeWork',
        value: SELECTION,
        filter: { op: '=', args: [{ property: 'dataset' }, 'https://ex/d/1'] },
      },
    ]);
    const projected = (dataset: string) =>
      projectDocument({ '@id': 'https://ex/work/4' }, work, schema, {
        dataset,
        matchedFilters: matcher,
      });

    expect(projected('https://ex/d/1').selections).toEqual([SELECTION]);
    expect(projected('https://ex/d/2')).not.toHaveProperty('selections');
  });

  it('matches nothing on a field without a value', () => {
    const node = { '@id': 'https://ex/work/2' };

    expect(
      project(node, about('a_overlaps', `${AUTHORITY}pottery`)),
    ).not.toHaveProperty('selections');
    expect(
      project(node, { op: '=', args: [{ property: 'genre' }, 'plate'] }),
    ).not.toHaveProperty('selections');
  });

  it('combines filters with and and or', () => {
    const node = workAbout(`${AUTHORITY}pottery`);
    const matching = about('a_contains', `${AUTHORITY}pottery`);
    const failing = { op: '=', args: [{ property: 'genre' }, 'cup'] };

    expect(
      project(node, { op: 'and', args: [matching, failing] }),
    ).not.toHaveProperty('selections');
    expect(
      project(node, { op: 'or', args: [matching, failing] }).selections,
    ).toEqual([SELECTION]);
  });

  it('gives a document every value it matches, each once', () => {
    const other = 'https://ex/selection/plates';
    const matcher = compileStoredFilters(schema, [
      {
        type: 'CreativeWork',
        value: SELECTION,
        filter: about('a_contains', `${AUTHORITY}pottery`),
      },
      {
        type: 'CreativeWork',
        value: SELECTION,
        filter: { op: '=', args: [{ property: 'genre' }, 'plate'] },
      },
      {
        type: 'CreativeWork',
        value: other,
        filter: { op: '=', args: [{ property: 'genre' }, 'plate'] },
      },
    ]);

    const document = projectDocument(
      workAbout(`${AUTHORITY}pottery`),
      work,
      schema,
      { matchedFilters: matcher },
    );

    expect(document.selections).toEqual([SELECTION, other]);
  });

  it('tests only documents of the type a filter names', () => {
    const matcher = compileStoredFilters(schema, [
      {
        type: 'CreativeWork',
        value: SELECTION,
        filter: about('a_contains', `${AUTHORITY}pottery`),
      },
    ]);

    expect(matcher(term, { about: [`${AUTHORITY}pottery`] })).toEqual([]);
  });

  it('reads a referent nested by a local lookup by its key', () => {
    // A `local` lookup nests the referent’s document under the field, so the
    // filter compares the nested document’s `id` – its key.
    const document = project(
      {
        '@id': 'https://ex/work/3',
        [alias('CreativeWork', 'subject')]: [
          {
            '@id': 'https://publisher.example/term/a',
            '@type': `${SCHEMA_ORG}DefinedTerm`,
            [alias('Term', 'name')]: [{ '@value': 'Pottery' }],
            [alias('Term', '_sameAs')]: [{ '@id': `${AUTHORITY}pottery` }],
          },
        ],
      },
      {
        op: 'a_contains',
        args: [{ property: 'subject' }, [`${AUTHORITY}pottery`]],
      },
    );

    expect(document.subject).toEqual([
      expect.objectContaining({ id: `${AUTHORITY}pottery` }),
    ]);
    expect(document.selections).toEqual([SELECTION]);
  });

  it('marks the document itself, never a copy nested in a referrer', () => {
    // A work nested by a `local` lookup holds only what the referring type’s
    // extraction carried, so a filter could answer differently there.
    const series = defineSearchType({
      name: 'Series',
      class: `${SCHEMA_ORG}CreativeWorkSeries`,
      fields: [
        {
          name: 'part',
          kind: 'reference',
          array: true,
          path: `<${SCHEMA_ORG}hasPart>`,
          output: true,
          ref: { strategy: 'lookup', target: 'CreativeWork', local: true },
        },
      ],
    });
    const nesting = searchSchema(term, work, media, series);
    const document = projectDocument(
      {
        '@id': 'https://ex/series/1',
        [alias('Series', 'part')]: [
          {
            '@id': 'https://ex/work/1',
            '@type': `${SCHEMA_ORG}CreativeWork`,
            [alias('CreativeWork', 'genre')]: ['plate'],
          },
        ],
      },
      series,
      nesting,
      {
        matchedFilters: compileStoredFilters(nesting, [
          {
            type: 'CreativeWork',
            value: SELECTION,
            filter: { op: '=', args: [{ property: 'genre' }, 'plate'] },
          },
        ]),
      },
    );

    expect(document.part).toEqual([
      expect.objectContaining({ id: 'https://ex/work/1', genre: 'plate' }),
    ]);
    expect(document.part).toEqual([
      expect.not.objectContaining({ selections: expect.anything() }),
    ]);
  });

  it('skips a stored value that is neither a string nor a keyed document', () => {
    const matcher = compileStoredFilters(schema, [
      {
        type: 'CreativeWork',
        value: SELECTION,
        filter: about('a_overlaps', `${AUTHORITY}pottery`),
      },
    ]);

    expect(matcher(work, { about: [{ name: 'Pottery' }, 7] })).toEqual([]);
  });

  it('is selected by a clause no facet drops, so every facet counts within it', () => {
    // The point of a field of its own: filtered on `about` itself, the `about`
    // facet would drop the clause and count the whole index.
    const query: SearchQuery = {
      where: [
        { or: [{ field: 'selections', in: [SELECTION] }] },
        { or: [{ field: 'about', in: [`${AUTHORITY}pottery`] }] },
      ],
      orderBy: [],
      limit: 20,
      offset: 0,
      facets: ['about'],
      locale: 'nl',
    };

    expect(validateQuery(query, work, schema)).toEqual([]);
    expect(facetSearches(query)).toEqual([
      {
        query: {
          ...query,
          where: [{ or: [{ field: 'selections', in: [SELECTION] }] }],
        },
        selected: { about: [`${AUTHORITY}pottery`] },
        own: 'about',
      },
    ]);
  });
});

describe('stored filters the schema cannot serve', () => {
  const problemsOf = (filters: unknown) => {
    try {
      compileStoredFilters(schema, filters);
    } catch (error) {
      return (error as Error).message.split('\n');
    }
    return [];
  };
  const withFilter = (filter: unknown) =>
    problemsOf([{ type: 'CreativeWork', value: SELECTION, filter }]);

  it('refuses anything but a list', () => {
    expect(problemsOf({})).toEqual(['Stored filters must be a JSON array.']);
  });

  it('reports every mistake at once, by the filter’s position', () => {
    expect(
      problemsOf([
        'nonsense',
        { type: 'CreativeWork', value: '', filter: {} },
        { type: 'Work', value: SELECTION, filter: {} },
        { type: 'Term', value: SELECTION, filter: {} },
        { type: 'Plain', value: SELECTION, filter: {} },
        {
          type: 'CreativeWork',
          value: 'pottery',
          filter: about('a_contains', 'x'),
        },
      ]),
    ).toEqual([
      'Stored filter 1 must be an object with “type”, “value” and “filter”.',
      'Stored filter 2 must name a “type” and a non-empty “value”, both strings.',
      'Stored filter 3 names type “Work”, which is not a root type of the schema.',
      'Stored filter 4 names type “Term”, which is keyed on “_sameAs”: several roots share one of its documents, which would hold the values of whichever root was written last.',
      "Stored filter 5 names type “Plain”, which declares no field “from: 'matchedFilters'” to hold its value.",
      'Stored filter 6 has value “pottery”, but “CreativeWork.selections” is a reference and stores absolute IRIs only.',
    ]);
  });

  it('refuses a key it does not know, so nothing is silently ignored', () => {
    expect(
      problemsOf([
        {
          type: 'CreativeWork',
          value: SELECTION,
          q: 'pottery',
          filter: about('a_contains', 'x'),
        },
      ]),
    ).toEqual([
      'Stored filter 1 has “q”; a stored filter holds “type”, “value” and “filter” only.',
    ]);
  });

  it('refuses a filter that is not CQL2 JSON it reads', () => {
    expect(withFilter('about = x')).toEqual([
      'Stored filter 1: a filter is a CQL2 JSON object with “op” and “args”, got "about = x".',
    ]);
    expect(withFilter({ op: 'not', args: [about('a_contains', 'x')] })).toEqual(
      [
        'Stored filter 1: operator "not" is not supported; use “and”, “or”, “=”, “in”, “a_contains” or “a_overlaps”.',
      ],
    );
    expect(withFilter({ op: 'and', args: [about('a_contains', 'x')] })).toEqual(
      ['Stored filter 1: “and” needs two or more filters.'],
    );
    expect(
      withFilter({ op: '=', args: ['plate', { property: 'genre' }] }),
    ).toEqual([
      'Stored filter 1: “=” takes two arguments, a { "property": … } and nothing else first, got ["plate",{"property":"genre"}].',
      'Stored filter 1: “=” compares a property to one string, got {"property":"genre"}.',
    ]);
    // A mistake inside a combination is reported once, where it is.
    expect(
      withFilter({
        op: 'or',
        args: [about('a_contains', 'x'), { op: 'like', args: [] }],
      }),
    ).toEqual([
      'Stored filter 1: operator "like" is not supported; use “and”, “or”, “=”, “in”, “a_contains” or “a_overlaps”.',
    ]);
    expect(withFilter(about('a_contains'))).toEqual([
      'Stored filter 1: “a_contains” compares a property to a list of one or more strings, got [].',
    ]);
  });

  it('refuses a property the filter cannot read', () => {
    const on = (property: string, op = '=', value: unknown = 'x') =>
      withFilter({ op, args: [{ property }, value] });

    expect(on('topic')).toEqual([
      'Stored filter 1: “CreativeWork” declares no field “topic”.',
    ]);
    expect(on('material')).toEqual([
      'Stored filter 1: field “material” is not declared before “selections”, so it has no value yet when the filter is tested.',
    ]);
    expect(on('selections')).toEqual([
      'Stored filter 1: field “selections” is not declared before “selections”, so it has no value yet when the filter is tested.',
    ]);
    expect(on('name')).toEqual([
      'Stored filter 1: field “name” cannot be filtered on; a stored filter reads keyword fields and references that are not inline.',
    ]);
    expect(on('status')).toEqual([
      'Stored filter 1: field “status” is filled outside the projection, so it has no value when the filter is tested.',
    ]);
    expect(on('media')).toEqual([
      'Stored filter 1: field “media” cannot be filtered on; a stored filter reads keyword fields and references that are not inline.',
    ]);
  });

  it('refuses an operator that does not fit the field', () => {
    expect(withFilter({ op: '=', args: [{ property: 'about' }, 'x'] })).toEqual(
      [
        'Stored filter 1: “=” compares one value, but “about” is an array; use “a_contains” or “a_overlaps”.',
      ],
    );
    expect(
      withFilter({ op: 'a_overlaps', args: [{ property: 'genre' }, ['x']] }),
    ).toEqual([
      'Stored filter 1: “a_overlaps” compares lists, but “genre” holds one value; use “=” or “in”.',
    ]);
  });
});
