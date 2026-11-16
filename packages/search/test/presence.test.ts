import { describe, expect, it } from 'vitest';
import type { FacetFieldsOf } from '../src/engine.js';
import { joinGraph } from '../src/join-graph.js';
import { projectDocument } from '../src/project.js';
import {
  companionNames,
  defineSearchType,
  facetNamed,
  facetsOf,
  isInternalField,
  physicalFields,
  searchSchema,
  validateSearchType,
  type FacetDeclaration,
  type SearchField,
  type SearchType,
} from '../src/schema.js';
import {
  facetSearches,
  filterOperator,
  selectionOf,
  validateQuery,
  type Filter,
  type SearchQuery,
} from '../src/query.js';

const SCHEMA_ORG = 'https://schema.org/';
const alias = (field: string) => `urn:lde:Work/${field}`;

const work = defineSearchType({
  name: 'Work',
  class: `${SCHEMA_ORG}CreativeWork`,
  fields: [
    {
      name: 'title',
      kind: 'keyword',
      path: `${SCHEMA_ORG}name`,
      output: true,
      filterable: true,
    },
    {
      name: 'dateCreated',
      kind: 'date',
      path: `${SCHEMA_ORG}dateCreated`,
      output: true,
      filterable: true,
      presence: true,
    },
    {
      name: 'image',
      kind: 'reference',
      path: `${SCHEMA_ORG}image`,
      array: true,
      presence: true,
    },
    {
      name: 'temporalCoverage',
      kind: 'period',
      path: `${SCHEMA_ORG}temporalCoverage`,
      presence: true,
    },
    {
      name: 'imageCount',
      kind: 'integer',
      derive: (document) =>
        (document.image as unknown[] | undefined)?.length || undefined,
      presence: true,
    },
  ],
});
const schema = searchSchema(work);

const browse: SearchQuery = {
  where: [],
  orderBy: [],
  limit: 10,
  offset: 0,
  facets: [],
  locale: 'nl',
};
const dated = (exists: boolean): Filter => ({
  or: [{ field: 'dateCreated', exists }],
});
const since = (min: string): Filter => ({
  or: [{ field: 'dateCreated', range: { min } }],
});

const withField = (field: Partial<SearchField>, extra: SearchType[] = []) =>
  searchSchema(
    {
      name: 'Thing',
      class: `${SCHEMA_ORG}Thing`,
      fields: [
        {
          name: 'field',
          kind: 'keyword',
          path: `${SCHEMA_ORG}name`,
          presence: true,
          ...field,
        } as SearchField,
      ],
    },
    ...extra,
  );

describe('declaring presence', () => {
  it('is no Role, so a field declaring it alone stays internal', () => {
    expect(isInternalField(work.fields[2])).toBe(true);
  });

  it('names a boolean companion beside the field', () => {
    expect(physicalFields(work.fields[1]).exists).toBe('dateCreated_exists');
    expect(physicalFields(work.fields[0]).exists).toBeUndefined();
    // Not among the value companions pruned with an internal field’s value.
    expect(companionNames(work.fields[1])).not.toContain('dateCreated_exists');
  });

  it('reserves the companion’s name', () => {
    expect(
      validateSearchType({
        ...work,
        fields: [
          ...work.fields,
          { name: 'dateCreated_exists', kind: 'keyword' },
        ],
      }),
    ).toContainEqual({
      field: 'dateCreated_exists',
      reason: 'reserved-field-name',
    });
  });

  it('refuses a field of a reference type, whose entries hold no companion', () => {
    const media = defineSearchType({
      name: 'MediaObject',
      fields: [
        {
          name: 'contentUrl',
          kind: 'keyword',
          path: `${SCHEMA_ORG}contentUrl`,
          output: true,
          presence: true,
        },
      ],
    });
    expect(() => searchSchema(media)).toThrow(
      /“MediaObject” is a reference type: presence is counted on a Root Type’s own field/,
    );
  });

  it('refuses an inline reference, which stores entries', () => {
    const media = defineSearchType({
      name: 'MediaObject',
      fields: [
        {
          name: 'contentUrl',
          kind: 'keyword',
          path: `${SCHEMA_ORG}contentUrl`,
          output: true,
        },
      ],
    });
    expect(() =>
      withField(
        {
          kind: 'reference',
          output: true,
          ref: { strategy: 'inline', typeName: 'MediaObject' },
        },
        [media],
      ),
    ).toThrow(/on an inline reference, which stores entries/);
  });

  it('refuses a text field, which stores its values per language', () => {
    expect(() =>
      withField({ kind: 'text', locales: ['nl'], output: true } as never),
    ).toThrow(/on a “text” field/);
  });

  it('refuses a boolean, which states its own absence', () => {
    expect(() => withField({ kind: 'boolean' } as never)).toThrow(
      /on a “boolean”, which states its own absence as “false”/,
    );
  });

  it('refuses a facetable field until its facet can hold both', () => {
    expect(() => withField({ facetable: true })).toThrow(
      /and is “facetable”: its facet would have to become an object/,
    );
  });

  it('files each refusal under a reason, for a declaration built outside TypeScript', () => {
    const declared = (field: object, type: object = {}) =>
      validateSearchType({
        name: 'Thing',
        class: `${SCHEMA_ORG}Thing`,
        ...type,
        fields: [{ name: 'field', kind: 'keyword', presence: true, ...field }],
      } as SearchType);

    expect(declared({}, { class: undefined })).toEqual([
      { field: 'field', reason: 'presence-on-reference-type' },
    ]);
    expect(
      declared({
        kind: 'reference',
        ref: { strategy: 'inline', typeName: 'Media' },
      }),
    ).toEqual([{ field: 'field', reason: 'presence-with-inline-ref' }]);
    expect(declared({ kind: 'text', locales: ['nl'] })).toEqual([
      { field: 'field', reason: 'presence-on-text' },
    ]);
    expect(declared({ kind: 'boolean' })).toEqual([
      { field: 'field', reason: 'presence-on-boolean' },
    ]);
    expect(declared({ facetable: true })).toEqual([
      { field: 'field', reason: 'presence-with-facetable' },
    ]);
    expect(declared({})).toEqual([]);
  });
});

describe('projecting a field declaring presence', () => {
  const project = (node: Record<string, unknown>) =>
    projectDocument({ '@id': 'https://ex/w', ...node }, work, schema);

  it('records a value as present, on the root document', () => {
    const document = project({
      [alias('dateCreated')]: { '@value': '1950' },
      [alias('image')]: [{ '@id': 'https://ex/w.jpg' }],
      [alias('temporalCoverage')]: '1935/1955',
    });

    expect(document).toMatchObject({
      dateCreated_exists: true,
      image_exists: true,
      temporalCoverage_exists: true,
      imageCount_exists: true,
    });
    // Declaring presence alone, a field is internal: its value, and a
    // period’s bounds, are pruned once its companion is written.
    for (const pruned of [
      'image',
      'temporalCoverage',
      'temporalCoverage_start',
      'temporalCoverage_end',
      'imageCount',
    ]) {
      expect(document).not.toHaveProperty(pruned);
    }
  });

  it('records no value as absent – `false`, not left out', () => {
    expect(project({})).toMatchObject({
      dateCreated_exists: false,
      image_exists: false,
      temporalCoverage_exists: false,
      imageCount_exists: false,
    });
  });

  it('counts an unreadable value as no value', () => {
    const document = project({
      [alias('dateCreated')]: { '@value': 'onbekend' },
      [alias('image')]: [{ '@value': 'not an IRI' }],
      [alias('temporalCoverage')]: 'onbekend',
    });

    expect(document).toMatchObject({
      dateCreated_exists: false,
      image_exists: false,
      temporalCoverage_exists: false,
    });
  });

  it('counts an empty list and a derived null as no value', () => {
    // A derived `array` reference stores the list its derive read, empty or
    // not, and a derived keyword stores the `null` it was handed.
    const derived = defineSearchType({
      name: 'Derived',
      class: `${SCHEMA_ORG}Thing`,
      fields: [
        {
          name: 'sameAs',
          kind: 'reference',
          array: true,
          derive: () => [],
          presence: true,
        },
        {
          name: 'note',
          kind: 'keyword',
          derive: () => null,
          presence: true,
        },
      ],
    });
    const document = projectDocument(
      { '@id': 'https://ex/d' },
      derived,
      searchSchema(derived),
    );

    expect(document.sameAs_exists).toBe(false);
    expect(document.note_exists).toBe(false);
  });
});

describe('presence on a lookup reading its literals as periods', () => {
  const term = defineSearchType({
    name: 'Term',
    class: `${SCHEMA_ORG}DefinedTerm`,
    fields: [
      {
        name: 'label',
        kind: 'text',
        path: `${SCHEMA_ORG}name`,
        locales: ['nl'],
        output: true,
        searchable: { weight: 1 },
      },
    ],
  });
  const covered = defineSearchType({
    name: 'Work',
    class: `${SCHEMA_ORG}CreativeWork`,
    fields: [
      {
        name: 'coverage',
        kind: 'reference',
        path: `${SCHEMA_ORG}temporalCoverage`,
        array: true,
        output: true,
        presence: true,
        ref: { strategy: 'lookup', target: 'Term', literal: 'period' },
      },
    ],
  });
  const project = (values: readonly unknown[]) =>
    projectDocument(
      { '@id': 'https://ex/w', [alias('coverage')]: values },
      covered,
      searchSchema(covered, term),
    );

  it('counts a period stated in place of a referent as a value', () => {
    expect(project(['1935/1955']).coverage_exists).toBe(true);
    expect(project([{ '@id': 'https://ex/t' }]).coverage_exists).toBe(true);
    expect(project([]).coverage_exists).toBe(false);
  });
});

describe('the presence facet', () => {
  it('is named after the field and reads the companion', () => {
    expect(facetNamed(work, 'dateCreated.exists', schema)).toEqual({
      name: 'dateCreated.exists',
      field: work.fields[1],
      engineField: 'dateCreated_exists',
      presence: true,
    });
    expect(facetsOf(work).map((facet) => facet.name)).toEqual([
      'dateCreated.exists',
      'image.exists',
      'temporalCoverage.exists',
      'imageCount.exists',
    ]);
  });

  it('is a facet a query may ask for, unlike the field itself', () => {
    expect(
      validateQuery(
        { ...browse, facets: ['dateCreated.exists', 'dateCreated'] },
        work,
        schema,
      ),
    ).toEqual([
      { part: 'facets', field: 'dateCreated', reason: 'not-facetable' },
    ]);
  });

  it('selects a bucket through `exists`', () => {
    const facet = facetNamed(work, 'image.exists', schema) as FacetDeclaration;

    expect(selectionOf(facet, 'false')).toEqual({
      or: [{ field: 'image', exists: false }],
    });
  });

  it('is typed among the facet names a declaration admits', () => {
    const admitted: FacetFieldsOf<typeof work> = 'dateCreated.exists';
    // @ts-expect-error – `title` declares no presence
    const refused: FacetFieldsOf<typeof work> = 'title.exists';

    expect([admitted, refused]).toHaveLength(2);
  });
});

describe('an `exists` criterion', () => {
  const where = (filter: Filter) =>
    validateQuery({ ...browse, where: [filter] }, work, schema);

  it('carries its own operator', () => {
    expect(filterOperator({ field: 'dateCreated', exists: true })).toBe(
      'exists',
    );
  });

  it('is accepted on a field declaring presence, filterable or not', () => {
    expect(where(dated(true))).toEqual([]);
    expect(where({ or: [{ field: 'image', exists: false }] })).toEqual([]);
  });

  it('is refused on a field declaring no presence', () => {
    expect(where({ or: [{ field: 'title', exists: true }] })).toEqual([
      { part: 'where', field: 'title', reason: 'no-presence' },
    ]);
  });

  it('leaves a field declaring presence alone unfilterable by value', () => {
    expect(
      where({ or: [{ field: 'image', in: ['https://ex/w.jpg'] }] }),
    ).toEqual([{ part: 'where', field: 'image', reason: 'not-filterable' }]);
  });

  it('is no operator on `id`', () => {
    expect(where({ or: [{ field: 'id', exists: true }] })).toEqual([
      { part: 'where', field: 'id', reason: 'operator-mismatch' },
    ]);
  });

  it('is refused inside a weld, whose leaves declare no presence', () => {
    const media = defineSearchType({
      name: 'MediaObject',
      fields: [
        {
          name: 'contentUrl',
          kind: 'keyword',
          path: `${SCHEMA_ORG}contentUrl`,
          filterable: true,
        },
      ],
    });
    const withMedia = defineSearchType({
      name: 'Work',
      class: `${SCHEMA_ORG}CreativeWork`,
      fields: [
        {
          name: 'associatedMedia',
          kind: 'reference',
          path: `${SCHEMA_ORG}associatedMedia`,
          array: true,
          filterable: true,
          ref: { strategy: 'inline', typeName: 'MediaObject' },
        },
      ],
    });
    const mediaSchema = searchSchema(withMedia, media);

    expect(
      validateQuery(
        {
          ...browse,
          where: [
            {
              or: [
                {
                  field: 'associatedMedia',
                  entry: [{ field: 'contentUrl', exists: true }],
                },
              ],
            },
          ],
        },
        withMedia,
        mediaSchema,
      ),
    ).toEqual([
      {
        part: 'where',
        field: 'associatedMedia.contentUrl',
        reason: 'no-presence',
      },
    ]);
  });

  it('is refused through a join, which reads no companion yet', () => {
    const dataset = defineSearchType({
      name: 'Dataset',
      class: 'https://example.org/Dataset',
      fields: [
        {
          name: 'label',
          kind: 'text',
          locales: ['nl'],
          output: true,
          searchable: { weight: 1 },
        },
        { name: 'issued', kind: 'date', presence: true },
      ],
    });
    const joined = defineSearchType({
      name: 'Work',
      class: `${SCHEMA_ORG}CreativeWork`,
      fields: [
        {
          name: 'dataset',
          kind: 'reference',
          filterable: true,
          labelSource: 'Dataset',
          joinable: true,
        },
      ],
    });
    const joinedSchema = searchSchema(dataset, joined);

    expect(
      validateQuery(
        {
          ...browse,
          where: [{ or: [{ on: ['dataset'], field: 'issued', exists: true }] }],
        },
        joined,
        joinedSchema,
        joinGraph(joinedSchema),
      ),
    ).toEqual([
      { part: 'where', field: 'dataset.issued', reason: 'joined-presence' },
    ]);
  });
});

describe('the clause a presence facet owns', () => {
  const query = (where: Filter[], facets: string[]): SearchQuery => ({
    ...browse,
    where,
    facets,
  });

  it('owns `exists`, and reports its value as selected', () => {
    const [search] = facetSearches(
      query([dated(false)], ['dateCreated.exists']),
    );

    expect(search).toMatchObject({
      own: 'dateCreated.exists',
      selected: { 'dateCreated.exists': ['false'] },
    });
    expect(search?.query.where).toEqual([]);
  });

  it('owns no range on the same field, and counts under it', () => {
    const searches = facetSearches(
      query([since('1900')], ['dateCreated.exists']),
    );

    expect(searches).toHaveLength(1);
    expect(searches[0]?.own).toBeUndefined();
    expect(searches[0]?.query.where).toEqual([since('1900')]);
  });

  it('keeps the two apart when both are selected, each facet owning its own', () => {
    // A facet on the field’s values never owns `exists`, nor the presence
    // facet the range – whichever of them a query asks for.
    const searches = facetSearches(
      query(
        [since('1900'), dated(true)],
        ['dateCreated', 'dateCreated.exists'],
      ),
    );

    expect(searches.map((search) => [search.own, search.query.where])).toEqual([
      ['dateCreated', [dated(true)]],
      ['dateCreated.exists', [since('1900')]],
    ]);
  });

  it('owns nothing in a clause that also names another field', () => {
    const searches = facetSearches(
      query(
        [
          {
            or: [
              { field: 'dateCreated', exists: true },
              { field: 'title', in: ['a'] },
            ],
          },
        ],
        ['dateCreated.exists'],
      ),
    );

    expect(searches[0]?.own).toBeUndefined();
  });
});
