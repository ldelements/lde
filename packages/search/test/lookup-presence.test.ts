import { describe, expect, it } from 'vitest';
import { projectDocument } from '../src/project.js';
import {
  defineSearchType,
  facetNamed,
  physicalFields,
  searchSchema,
  type FacetDeclaration,
  type SearchType,
} from '../src/schema.js';
import {
  facetSearches,
  selectionOf,
  validateQuery,
  type SearchQuery,
} from '../src/query.js';

const SCHEMA_ORG = 'https://schema.org/';
const alias = (type: string, field: string) => `urn:lde:${type}/${field}`;

const placeOf = (name: string, className: string) =>
  defineSearchType({
    name,
    class: className,
    fields: [
      {
        name: 'label',
        kind: 'text',
        path: `${SCHEMA_ORG}name`,
        locales: ['nl'],
        output: true,
        searchable: { weight: 1 },
      },
      {
        name: 'latitude',
        kind: 'number',
        path: `${SCHEMA_ORG}latitude`,
        output: true,
      },
    ],
  });
const place = placeOf('Place', `${SCHEMA_ORG}Place`);
const landform = placeOf('Landform', `${SCHEMA_ORG}Landform`);

const workWith = (ref: Record<string, unknown>): SearchType =>
  ({
    name: 'Work',
    class: `${SCHEMA_ORG}CreativeWork`,
    fields: [
      {
        name: 'contentLocation',
        kind: 'reference',
        path: `${SCHEMA_ORG}contentLocation`,
        array: true,
        output: true,
        filterable: true,
        ref: {
          strategy: 'lookup',
          target: 'Place',
          presenceLeaves: ['latitude'],
          ...ref,
        },
      },
    ],
  }) as never;
const work = workWith({});
const schema = searchSchema(work, place);
const browse: SearchQuery = {
  where: [],
  orderBy: [],
  limit: 10,
  offset: 0,
  facets: [],
  locale: 'nl',
};

describe('presence leaves on a lookup', () => {
  it('names one boolean per leaf on the root document', () => {
    expect(physicalFields(work.fields[0]).leafExists).toEqual([
      { leaf: 'latitude', exists: 'contentLocation_latitude_exists' },
    ]);
  });

  it('serves the facet `‹reference›.‹leaf›.exists`, read through the target', () => {
    expect(facetNamed(work, 'contentLocation.latitude.exists', schema)).toEqual(
      {
        name: 'contentLocation.latitude.exists',
        field: place.fields[1],
        reference: work.fields[0],
        engineField: 'contentLocation_latitude_exists',
        presence: true,
      },
    );
  });

  it('is refused on a lookup naming several targets', () => {
    expect(() =>
      searchSchema(
        workWith({ target: ['Place', 'Landform'] }),
        place,
        landform,
      ),
    ).toThrow(
      /Reference “Work.contentLocation” declares “presenceLeaves” and names several targets/,
    );
  });

  it('requires the target to declare the leaf, with a path', () => {
    const unlocated = defineSearchType({ ...place, fields: [place.fields[0]] });
    expect(() => searchSchema(work, unlocated)).toThrow(
      /names presence leaf “latitude”, which “Place” does not declare/,
    );
    const derived = defineSearchType({
      ...place,
      fields: [
        place.fields[0],
        { name: 'latitude', kind: 'number', output: true, derive: () => 1 },
      ],
    });
    expect(() => searchSchema(work, derived)).toThrow(
      /names presence leaf “latitude”, which declares no “path”/,
    );
  });

  it('is refused on a joinable lookup, whose `where` joins', () => {
    expect(() =>
      searchSchema(
        {
          ...work,
          fields: [{ ...work.fields[0], joinable: true }],
        } as SearchType,
        place,
      ),
    ).toThrow(/declares “presenceLeaves” and is “joinable”/);
  });
});

describe('projecting a lookup’s presence leaves', () => {
  const project = (referents: unknown[] | undefined) =>
    projectDocument(
      {
        '@id': 'https://ex/w',
        ...(referents !== undefined && {
          [alias('Work', 'contentLocation')]: referents,
        }),
      },
      work,
      schema,
    );

  it('records a value when any referent’s node states the leaf', () => {
    const document = project([
      { '@id': 'https://ex/p/1' },
      {
        '@id': 'https://ex/p/2',
        [alias('Place', 'latitude')]: { '@value': '51.37' },
      },
    ]);

    expect(document.contentLocation_latitude_exists).toBe(true);
    expect(document.contentLocation).toEqual([
      'https://ex/p/1',
      'https://ex/p/2',
    ]);
  });

  it('records no value for a referent named by IRI alone, or none at all', () => {
    expect(project(['https://ex/p/1']).contentLocation_latitude_exists).toBe(
      false,
    );
    expect(
      project([
        {
          '@id': 'https://ex/p/1',
          [alias('Place', 'latitude')]: { '@value': 'not a number' },
        },
      ]).contentLocation_latitude_exists,
    ).toBe(false);
    expect(project(undefined).contentLocation_latitude_exists).toBe(false);
  });

  it('counts no blank-node referent, which the lookup stores no id for', () => {
    const document = project([
      { [alias('Place', 'latitude')]: { '@value': '51.37' } },
      { '@id': '_:b0', [alias('Place', 'latitude')]: { '@value': '51.37' } },
    ]);

    expect(document.contentLocation_latitude_exists).toBe(false);
    expect(document.contentLocation).toBeUndefined();
  });
});

describe('`exists` on a lookup’s leaf', () => {
  const where = (...criteria: Record<string, unknown>[]) =>
    validateQuery(
      {
        ...browse,
        where: criteria.map((criterion) => ({ or: [criterion] }) as never),
      },
      work,
      schema,
    );

  it('is a plain criterion naming the reference and the leaf', () => {
    expect(
      where({ field: 'contentLocation', leaf: 'latitude', exists: true }),
    ).toEqual([]);
  });

  it('is refused on a leaf the lookup counts no presence for', () => {
    expect(
      where({ field: 'contentLocation', leaf: 'label', exists: true }),
    ).toEqual([
      {
        part: 'where',
        field: 'contentLocation.label',
        reason: 'no-presence',
      },
    ]);
  });

  it('welds nothing: a lookup has no entries', () => {
    expect(
      where({
        field: 'contentLocation',
        entry: [{ field: 'latitude', exists: true }],
      }),
    ).toEqual([
      { part: 'where', field: 'contentLocation', reason: 'not-weldable' },
    ]);
  });

  it('is selected, and owned, on the leaf’s presence axis', () => {
    const facet = facetNamed(
      work,
      'contentLocation.latitude.exists',
      schema,
    ) as FacetDeclaration;
    const selection = selectionOf(facet, 'false');
    expect(selection).toEqual({
      or: [{ field: 'contentLocation', leaf: 'latitude', exists: false }],
    });

    const [search] = facetSearches({
      ...browse,
      where: [selection],
      facets: ['contentLocation.latitude.exists'],
    });
    expect(search?.own).toBe('contentLocation.latitude.exists');
    expect(search?.query.where).toEqual([]);
    expect(search?.selected).toEqual({
      'contentLocation.latitude.exists': ['false'],
    });
  });
});
