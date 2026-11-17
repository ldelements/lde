import { describe, expect, it } from 'vitest';
import type { FacetFieldsOf } from '../src/engine.js';
import { joinGraph } from '../src/join-graph.js';
import { projectDocument } from '../src/project.js';
import {
  defineSearchType,
  facetNamed,
  facetsOf,
  physicalFields,
  searchSchema,
  validateSearchType,
  type FacetDeclaration,
  type SearchField,
  type SearchType,
} from '../src/schema.js';
import {
  facetSearches,
  selectionOf,
  validateQuery,
  type Criterion,
  type Filter,
  type SearchQuery,
} from '../src/query.js';

const SCHEMA_ORG = 'https://schema.org/';

/** A reproduction: a thumbnail only counted, a format filtered by, a licence
 *  faceted on, a caption only shown and a flag. */
const mediaObject = defineSearchType({
  name: 'MediaObject',
  fields: [
    {
      name: 'thumbnailUrl',
      kind: 'keyword',
      path: `${SCHEMA_ORG}thumbnailUrl`,
    },
    {
      name: 'encodingFormat',
      kind: 'keyword',
      path: `${SCHEMA_ORG}encodingFormat`,
      output: true,
      filterable: true,
    },
    {
      name: 'license',
      kind: 'reference',
      path: `${SCHEMA_ORG}license`,
      output: true,
      filterable: true,
      ref: { strategy: 'idOnly' },
    },
    {
      name: 'caption',
      kind: 'text',
      path: `${SCHEMA_ORG}caption`,
      locales: ['nl'],
      output: true,
    },
    {
      name: 'isFree',
      kind: 'boolean',
      path: `${SCHEMA_ORG}isAccessibleForFree`,
      output: true,
    },
  ],
});

const workWith = (
  ref: Record<string, unknown>,
  extra: Partial<SearchField> = {},
): SearchType =>
  ({
    name: 'Work',
    class: `${SCHEMA_ORG}CreativeWork`,
    fields: [
      {
        name: 'associatedMedia',
        kind: 'reference',
        path: `${SCHEMA_ORG}associatedMedia`,
        array: true,
        output: true,
        filterable: true,
        ...extra,
        ref: { strategy: 'inline', typeName: 'MediaObject', ...ref },
      },
    ],
  }) as never;

const work = workWith({
  presenceLeaves: ['thumbnailUrl'],
  facetedLeaves: ['license'],
});
const schema = searchSchema(work, mediaObject);
const facet = 'associatedMedia.thumbnailUrl.exists';
const browse: SearchQuery = {
  where: [],
  orderBy: [],
  limit: 10,
  offset: 0,
  facets: [],
  locale: 'nl',
};
const welded = (...entry: Criterion[]): Filter => ({
  or: [{ field: 'associatedMedia', entry }],
});

describe('declaring presence leaves', () => {
  it('names one boolean per leaf on the root document', () => {
    expect(physicalFields(work.fields[0]).leafExists).toEqual([
      { leaf: 'thumbnailUrl', exists: 'associatedMedia_thumbnailUrl_exists' },
    ]);
    expect(physicalFields(mediaObject.fields[1]).leafExists).toEqual([]);
    expect(physicalFields(mediaObject.fields[3]).leafExists).toEqual([]);
  });

  it('reserves the boolean’s name', () => {
    expect(
      validateSearchType({
        ...work,
        fields: [
          ...work.fields,
          { name: 'associatedMedia_thumbnailUrl_exists', kind: 'keyword' },
        ],
      }),
    ).toContainEqual({
      field: 'associatedMedia_thumbnailUrl_exists',
      reason: 'reserved-field-name',
    });
  });

  it('files what one declaration can tell under a reason', () => {
    const issues = (field: Record<string, unknown>, type: object = {}) =>
      validateSearchType({
        name: 'Work',
        class: `${SCHEMA_ORG}CreativeWork`,
        ...type,
        fields: [
          {
            name: 'associatedMedia',
            kind: 'reference',
            filterable: true,
            ref: {
              strategy: 'inline',
              typeName: 'MediaObject',
              presenceLeaves: ['thumbnailUrl'],
            },
            ...field,
          },
        ],
      } as SearchType);

    expect(issues({}, { class: undefined })).toEqual([
      { field: 'associatedMedia', reason: 'presence-leaves-on-reference-type' },
    ]);
    expect(
      issues({
        ref: { strategy: 'idOnly', presenceLeaves: ['thumbnailUrl'] },
      }),
    ).toEqual([
      { field: 'associatedMedia', reason: 'presence-leaves-on-id-only' },
    ]);
    const lookup = {
      strategy: 'lookup',
      target: 'Place',
      presenceLeaves: ['latitude'],
    };
    expect(issues({ ref: lookup })).toEqual([]);
    expect(
      issues({ ref: lookup, labelSource: 'Place', joinable: true }),
    ).toEqual([
      { field: 'associatedMedia', reason: 'presence-leaves-with-joinable' },
    ]);
    expect(issues({ ref: { ...lookup, literal: 'period' } })).toEqual([
      { field: 'associatedMedia', reason: 'presence-leaves-with-literal' },
    ]);
    expect(issues({ filterable: undefined })).toEqual([
      {
        field: 'associatedMedia',
        reason: 'presence-leaves-without-filterable',
      },
    ]);
    expect(
      issues({
        ref: {
          strategy: 'inline',
          typeName: 'MediaObject',
          presenceLeaves: ['thumbnailUrl', 'thumbnailUrl'],
        },
      }),
    ).toEqual([
      { field: 'associatedMedia', reason: 'presence-leaves-duplicate' },
    ]);
    expect(issues({ facetable: true })).toEqual([]);
    // A leaf is resolved against the reference type, which one declaration
    // cannot see: `searchSchema` checks it.
    expect(
      issues({
        ref: {
          strategy: 'inline',
          typeName: 'MediaObject',
          presenceLeaves: ['nope'],
        },
      }),
    ).toEqual([]);
    expect(issues({})).toEqual([]);
  });

  it('accepts a facetable reference, whose own facet sits beside its leaves’', () => {
    const licence = defineSearchType({
      name: 'Licence',
      class: `${SCHEMA_ORG}CreativeWork`,
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
    const licensed = defineSearchType({
      ...mediaObject,
      fields: [
        ...mediaObject.fields.filter((field) => field.name !== 'license'),
        {
          name: 'license',
          kind: 'reference',
          path: `${SCHEMA_ORG}license`,
          filterable: true,
          ref: { strategy: 'lookup', target: 'Licence' },
        },
      ],
    });
    const facetable = {
      ...workWith(
        { presenceLeaves: ['thumbnailUrl'], identity: 'license' },
        { facetable: true },
      ),
      class: `${SCHEMA_ORG}VisualArtwork`,
    } as SearchType;
    const schema = searchSchema(facetable, licensed, licence);
    expect(facetsOf(facetable, schema).map((facet) => facet.name)).toEqual([
      'associatedMedia',
      'associatedMedia.thumbnailUrl.exists',
    ]);
  });

  it('refuses a leaf named like a part of the facet object', () => {
    const named = defineSearchType({
      name: 'MediaObject',
      fields: [
        { name: 'exists', kind: 'keyword', path: `${SCHEMA_ORG}exists` },
        { name: 'buckets', kind: 'keyword', path: `${SCHEMA_ORG}buckets` },
      ],
    });
    expect(() =>
      searchSchema(workWith({ presenceLeaves: ['exists'] }), named),
    ).toThrow(
      /names presence leaf “exists”: “buckets”, “totalValues” and “exists”/,
    );
    expect(() =>
      searchSchema(workWith({ facetedLeaves: ['buckets'] }), {
        ...named,
        fields: [{ ...named.fields[1], filterable: true }],
      } as SearchType),
    ).toThrow(
      /names faceted leaf “buckets”: “buckets”, “totalValues” and “exists”/,
    );
  });

  it('accepts a reference type whose only key a weld can name is a presence leaf', () => {
    const counted = defineSearchType({
      name: 'MediaObject',
      fields: [
        {
          name: 'thumbnailUrl',
          kind: 'keyword',
          path: `${SCHEMA_ORG}thumbnailUrl`,
          output: true,
        },
      ],
    });
    expect(() =>
      searchSchema(workWith({ presenceLeaves: ['thumbnailUrl'] }), counted),
    ).not.toThrow();
  });

  it('says why in full when the schema is built', () => {
    expect(() =>
      searchSchema(
        workWith(
          { presenceLeaves: ['thumbnailUrl'] },
          { filterable: undefined },
        ),
        mediaObject,
      ),
    ).toThrow(/declares “presenceLeaves” without “filterable”/);
    expect(() =>
      searchSchema(
        workWith({ presenceLeaves: ['thumbnailUrl', 'thumbnailUrl'] }),
        mediaObject,
      ),
    ).toThrow(/names one leaf twice/);
    expect(() =>
      searchSchema(
        {
          ...work,
          fields: [
            {
              name: 'creator',
              kind: 'reference',
              filterable: true,
              ref: { strategy: 'idOnly', presenceLeaves: ['x'] },
            } as never,
          ],
        },
        mediaObject,
      ),
    ).toThrow(/names no type its referents are read through/);
  });

  it('refuses a leaf the reference type does not declare', () => {
    expect(() =>
      searchSchema(workWith({ presenceLeaves: ['nope'] }), mediaObject),
    ).toThrow(
      /names presence leaf “nope”, which “MediaObject” does not declare/,
    );
  });

  it('refuses a text or boolean leaf, as on a field of the root’s own', () => {
    expect(() =>
      searchSchema(workWith({ presenceLeaves: ['caption'] }), mediaObject),
    ).toThrow(/presence leaf “caption”, a “text”/);
    expect(() =>
      searchSchema(workWith({ presenceLeaves: ['isFree'] }), mediaObject),
    ).toThrow(/presence leaf “isFree”, a “boolean”/);
  });

  it('refuses a leaf that is itself an inline reference', () => {
    const thumbnail = defineSearchType({
      name: 'Thumbnail',
      fields: [
        {
          name: 'url',
          kind: 'keyword',
          path: `${SCHEMA_ORG}url`,
          output: true,
        },
      ],
    });
    const media = defineSearchType({
      ...mediaObject,
      fields: [
        ...mediaObject.fields,
        {
          name: 'thumbnail',
          kind: 'reference',
          path: `${SCHEMA_ORG}thumbnail`,
          output: true,
          ref: { strategy: 'inline', typeName: 'Thumbnail' },
        },
      ],
    });
    expect(() =>
      searchSchema(
        workWith({ presenceLeaves: ['thumbnail'] }),
        media,
        thumbnail,
      ),
    ).toThrow(/presence leaf “thumbnail”, which is itself an inline reference/);
  });

  it('accepts a leaf counted both by value and by presence', () => {
    const both = workWith({
      presenceLeaves: ['license'],
      facetedLeaves: ['license'],
    });
    expect(
      facetsOf(both, searchSchema(both, mediaObject)).map(
        (facet) => facet.name,
      ),
    ).toEqual(['associatedMedia.license', 'associatedMedia.license.exists']);
  });

  it('refuses one on a reference type, which has no documents to count', () => {
    const edge = defineSearchType({
      name: 'Edge',
      fields: [
        {
          name: 'media',
          kind: 'reference',
          path: `${SCHEMA_ORG}associatedMedia`,
          output: true,
          filterable: true,
          ref: {
            strategy: 'inline',
            typeName: 'MediaObject',
            presenceLeaves: ['thumbnailUrl'],
          },
        },
      ],
    });
    expect(() => searchSchema(edge, mediaObject)).toThrow(
      /“Edge” is a reference type: presence is counted on a root document/,
    );
  });

  it('accepts two references that nest one type with different leaves, each filtered by its own input', () => {
    const collection = {
      ...workWith({}),
      name: 'Collection',
      class: `${SCHEMA_ORG}Collection`,
    } as SearchType;
    expect(() => searchSchema(work, collection, mediaObject)).not.toThrow();
  });
});

describe('projecting presence leaves', () => {
  const alias = (type: string, field: string) => `urn:lde:${type}/${field}`;
  const project = (entries?: Record<string, unknown>[]) =>
    projectDocument(
      {
        '@id': 'https://ex/w',
        ...(entries !== undefined && {
          [alias('Work', 'associatedMedia')]: entries.map((entry, index) => ({
            '@id': `https://ex/m/${index}`,
            ...Object.fromEntries(
              Object.entries(entry).map(([name, value]) => [
                alias('MediaObject', name),
                value,
              ]),
            ),
          })),
        }),
      },
      work,
      schema,
    );

  it('records a value when any entry holds one, even if another lacks it', () => {
    const document = project([
      { thumbnailUrl: 'https://ex/t.jpg', encodingFormat: 'image/jpeg' },
      { encodingFormat: 'image/tiff' },
    ]);

    expect(document.associatedMedia_thumbnailUrl_exists).toBe(true);
    // The leaf declares no Role, so it is pruned from the entries once counted.
    expect(document.associatedMedia).toEqual([
      { encodingFormat: 'image/jpeg' },
      { encodingFormat: 'image/tiff' },
    ]);
  });

  it('records no value when no entry holds one, or there are no entries', () => {
    expect(
      project([{ encodingFormat: 'image/png' }])
        .associatedMedia_thumbnailUrl_exists,
    ).toBe(false);
    expect(project().associatedMedia_thumbnailUrl_exists).toBe(false);
  });

  it('counts the one entry of a single-valued reference', () => {
    const single = {
      ...work,
      fields: [{ ...work.fields[0], array: undefined }],
    } as SearchType;
    const document = projectDocument(
      {
        '@id': 'https://ex/w',
        [alias('Work', 'associatedMedia')]: {
          '@id': 'https://ex/m',
          [alias('MediaObject', 'thumbnailUrl')]: 'https://ex/t.jpg',
        },
      },
      single,
      searchSchema(single, mediaObject),
    );

    expect(document.associatedMedia_thumbnailUrl_exists).toBe(true);
  });

  it('writes nothing without a schema, which projects no entries', () => {
    expect(projectDocument({ '@id': 'https://ex/w' }, work)).not.toHaveProperty(
      'associatedMedia_thumbnailUrl_exists',
    );
  });
});

describe('the presence leaf’s facet', () => {
  it('is named by the leaf’s path and reads the root’s boolean', () => {
    expect(facetNamed(work, facet, schema)).toEqual({
      name: facet,
      field: mediaObject.fields[0],
      reference: work.fields[0],
      engineField: 'associatedMedia_thumbnailUrl_exists',
      presence: true,
    });
    expect(facetsOf(work, schema).map((declared) => declared.name)).toEqual([
      'associatedMedia.license',
      facet,
    ]);
  });

  it('selects a bucket through `exists` welded to one entry alone', () => {
    const clause = selectionOf(
      facetNamed(work, facet, schema) as FacetDeclaration,
      'false',
    );

    expect(clause).toEqual(welded({ field: 'thumbnailUrl', exists: false }));
    expect(
      facetSearches({ ...browse, where: [clause], facets: [facet] })[0]?.own,
    ).toBe(facet);
  });
});

describe('`exists` welded to an entry', () => {
  const where = (filter: Filter) =>
    validateQuery({ ...browse, where: [filter] }, work, schema);

  it('is accepted alone, on a presence leaf', () => {
    expect(where(welded({ field: 'thumbnailUrl', exists: true }))).toEqual([]);
  });

  it('is refused on a leaf the reference names no presence for', () => {
    expect(where(welded({ field: 'encodingFormat', exists: true }))).toEqual([
      {
        part: 'where',
        field: 'associatedMedia.encodingFormat',
        reason: 'no-presence',
      },
    ]);
  });

  it('is refused beside another condition on the same entry', () => {
    expect(
      where(
        welded(
          { field: 'encodingFormat', in: ['image/jpeg'] },
          { field: 'thumbnailUrl', exists: true },
        ),
      ),
    ).toEqual([
      {
        part: 'where',
        field: 'associatedMedia.thumbnailUrl',
        reason: 'exists-in-weld',
      },
    ]);
  });

  it('is refused through a join, which reads no companion yet', () => {
    const item = defineSearchType({
      name: 'Item',
      class: `${SCHEMA_ORG}Thing`,
      fields: [
        {
          name: 'work',
          kind: 'reference',
          filterable: true,
          labelSource: 'Work',
          joinable: true,
        },
      ],
    });
    const labelled = {
      ...work,
      fields: [
        ...work.fields,
        {
          name: 'label',
          kind: 'text',
          locales: ['nl'],
          output: true,
          searchable: { weight: 1 },
        },
      ],
    } as SearchType;
    const joinedSchema = searchSchema(labelled, item, mediaObject);

    expect(
      validateQuery(
        {
          ...browse,
          where: [
            {
              or: [
                {
                  on: ['work'],
                  field: 'associatedMedia',
                  entry: [{ field: 'thumbnailUrl', exists: true }],
                },
              ],
            },
          ],
        },
        item,
        joinedSchema,
        joinGraph(joinedSchema),
      ),
    ).toEqual([
      {
        part: 'where',
        field: 'work.associatedMedia',
        reason: 'joined-presence',
      },
    ]);
  });
});

describe('the clause a presence leaf’s facet owns', () => {
  it('owns `exists` welded alone, never a condition on the leaf’s value', () => {
    const presence = welded({ field: 'thumbnailUrl', exists: true });
    const value = welded({ field: 'license', in: ['https://ex/l'] });
    const searches = facetSearches({
      ...browse,
      where: [presence, value],
      facets: [facet, 'associatedMedia.license'],
    });

    expect(searches.map((search) => [search.own, search.query.where])).toEqual([
      [facet, [value]],
      ['associatedMedia.license', [presence]],
    ]);
  });
});

describe('the facet names a typed declaration admits', () => {
  it('includes each presence leaf’s facet by its path', () => {
    const typed = defineSearchType({
      name: 'Work',
      class: `${SCHEMA_ORG}CreativeWork`,
      fields: [
        {
          name: 'associatedMedia',
          kind: 'reference',
          path: `${SCHEMA_ORG}associatedMedia`,
          array: true,
          filterable: true,
          ref: {
            strategy: 'inline',
            typeName: 'MediaObject',
            presenceLeaves: ['thumbnailUrl'],
          },
        },
      ],
    });
    const admitted: FacetFieldsOf<typeof typed> =
      'associatedMedia.thumbnailUrl.exists';
    // @ts-expect-error – not a presence leaf
    const refused: FacetFieldsOf<typeof typed> =
      'associatedMedia.encodingFormat.exists';

    expect([typed.name, admitted, refused]).toHaveLength(3);
  });
});
