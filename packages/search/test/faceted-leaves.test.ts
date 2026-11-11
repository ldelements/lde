import { describe, expect, it } from 'vitest';
import type { FacetFieldsOf } from '../src/engine.js';
import {
  defineSearchType,
  facetNamed,
  facetsOf,
  searchSchema,
  type SearchField,
  type SearchType,
} from '../src/schema.js';
import {
  facetSearches,
  selectionOf,
  validateQuery,
  type SearchQuery,
} from '../src/query.js';

const SCHEMA_ORG = 'https://schema.org/';

/** A reproduction: a licence, a format, and a caption only shown. */
const mediaObject = defineSearchType({
  name: 'MediaObject',
  fields: [
    {
      name: 'license',
      kind: 'reference',
      path: `${SCHEMA_ORG}license`,
      output: true,
      filterable: true,
      ref: { strategy: 'idOnly' },
    },
    {
      name: 'encodingFormat',
      kind: 'keyword',
      path: `${SCHEMA_ORG}encodingFormat`,
      output: true,
      filterable: true,
    },
    {
      name: 'caption',
      kind: 'text',
      path: `${SCHEMA_ORG}caption`,
      locales: ['nl'],
      output: true,
    },
    {
      name: 'tag',
      kind: 'keyword',
      path: `${SCHEMA_ORG}keywords`,
      output: true,
    },
  ],
});

const workFaceting = (
  facetedLeaves: readonly string[],
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
        ref: { strategy: 'inline', typeName: 'MediaObject', facetedLeaves },
      },
    ],
  }) as never;

describe('declaring the leaves a root document is faceted on', () => {
  it('accepts a filterable keyword or reference leaf', () => {
    expect(() =>
      searchSchema(workFaceting(['license', 'encodingFormat']), mediaObject),
    ).not.toThrow();
  });

  it('rejects a leaf the reference type does not declare', () => {
    expect(() => searchSchema(workFaceting(['nope']), mediaObject)).toThrow(
      /names faceted leaf “nope”, which “MediaObject” does not declare/,
    );
  });

  it('rejects a leaf named twice', () => {
    expect(() =>
      searchSchema(workFaceting(['license', 'license']), mediaObject),
    ).toThrow(/names faceted leaf “license” twice/);
  });

  it('rejects a leaf that is not filterable, so its bucket selects nothing', () => {
    expect(() => searchSchema(workFaceting(['tag']), mediaObject)).toThrow(
      /which is not “filterable”/,
    );
  });

  it('rejects a text leaf, which keys no bucket', () => {
    expect(() => searchSchema(workFaceting(['caption']), mediaObject)).toThrow(
      /a “text”: only a “keyword”, “boolean” or “reference” leaf/,
    );
  });

  it('rejects a leaf that stores a nested object', () => {
    const withNested = defineSearchType({
      ...mediaObject,
      fields: [
        ...mediaObject.fields,
        {
          name: 'creator',
          kind: 'reference',
          path: `${SCHEMA_ORG}creator`,
          output: true,
          ref: { strategy: 'inline', typeName: 'Agent' },
        },
      ],
    });
    const agent = defineSearchType({
      name: 'Agent',
      fields: [
        {
          name: 'name',
          kind: 'keyword',
          path: `${SCHEMA_ORG}name`,
          output: true,
        },
      ],
    });
    expect(() =>
      searchSchema(workFaceting(['creator']), withNested, agent),
    ).toThrow(/“creator”, which stores a nested object/);
  });

  it('rejects a reference that is facetable itself, whose facet shares its name', () => {
    const person = defineSearchType({
      name: 'Person',
      class: `${SCHEMA_ORG}Person`,
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
    const role = defineSearchType({
      name: 'MediaObject',
      fields: [
        ...mediaObject.fields,
        {
          name: 'creator',
          kind: 'reference',
          path: `${SCHEMA_ORG}creator`,
          output: true,
          filterable: true,
          ref: { strategy: 'lookup', target: 'Person' },
        },
      ],
    });
    const both = {
      ...workFaceting(['license'], { facetable: true }),
    } as SearchType;
    const reference = both.fields[0] as SearchField & { ref: object };
    const withIdentity = {
      ...both,
      fields: [
        { ...reference, ref: { ...reference.ref, identity: 'creator' } },
      ],
    } as never;

    expect(() => searchSchema(withIdentity, role, person)).toThrow(
      /is “facetable” and declares “facetedLeaves”/,
    );
  });

  it('rejects a reference that is not filterable', () => {
    expect(() =>
      searchSchema(
        workFaceting(['license'], { filterable: undefined }),
        mediaObject,
      ),
    ).toThrow(/declares “facetedLeaves” without “filterable”/);
  });

  it('rejects faceted leaves inside a reference type, which has no documents to count', () => {
    const edge = defineSearchType({
      name: 'Edge',
      fields: [
        {
          name: 'media',
          kind: 'reference',
          path: `${SCHEMA_ORG}associatedMedia`,
          output: true,
          ref: {
            strategy: 'inline',
            typeName: 'MediaObject',
            facetedLeaves: ['license'],
          },
        },
      ],
    });
    const root = defineSearchType({
      name: 'Work',
      class: `${SCHEMA_ORG}CreativeWork`,
      fields: [
        {
          name: 'creator',
          kind: 'reference',
          path: `${SCHEMA_ORG}creator`,
          output: true,
          ref: { strategy: 'inline', typeName: 'Edge' },
        },
      ],
    });
    expect(() => searchSchema(root, edge, mediaObject)).toThrow(
      /“Edge” is a reference type: a faceted leaf counts root documents/,
    );
  });
});

describe('a faceted leaf whose target narrows its facets', () => {
  it('is refused, since the nested path cannot apply the policy', () => {
    const licence = defineSearchType({
      name: 'Licence',
      class: `${SCHEMA_ORG}CreativeWork`,
      facetKeys: { only: (id: string) => id.startsWith('https://ok/') },
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
    const media = defineSearchType({
      name: 'MediaObject',
      fields: [
        {
          name: 'license',
          kind: 'reference',
          path: `${SCHEMA_ORG}license`,
          output: true,
          filterable: true,
          ref: { strategy: 'lookup', target: 'Licence' },
        },
      ],
    });
    const root = {
      ...workFaceting(['license']),
      class: `${SCHEMA_ORG}VisualArtwork`,
    } as SearchType;

    expect(() => searchSchema(root, media, licence)).toThrow(
      /target “Licence” declares “facetKeys”/,
    );
  });
});

describe('the facets a root type serves', () => {
  const work = workFaceting(['license']);
  const schema = searchSchema(work, mediaObject);

  it('names a faceted leaf by its path, faceted on the nested path', () => {
    expect(facetsOf(work, schema)).toEqual([
      {
        name: 'associatedMedia.license',
        field: mediaObject.fields[0],
        reference: work.fields[0],
        engineField: 'associatedMedia.license',
      },
    ]);
  });

  it('names no faceted leaf without a schema to resolve the reference type', () => {
    expect(facetsOf(work)).toEqual([]);
  });

  it('accepts the path as a facet a query asks for', () => {
    const query: SearchQuery = {
      where: [],
      orderBy: [],
      limit: 10,
      offset: 0,
      facets: ['associatedMedia.license'],
      locale: 'nl',
    };
    expect(validateQuery(query, work, schema)).toEqual([]);
    expect(
      validateQuery(
        { ...query, facets: ['associatedMedia.encodingFormat'] },
        work,
        schema,
      ),
    ).toEqual([
      {
        part: 'facets',
        field: 'associatedMedia.encodingFormat',
        reason: 'unknown-field',
      },
    ]);
  });
});

describe('the clause a faceted leaf owns', () => {
  const base: SearchQuery = {
    where: [],
    orderBy: [],
    limit: 10,
    offset: 0,
    facets: ['associatedMedia.license'],
    locale: 'nl',
  };
  const CC_BY = 'https://creativecommons.org/licenses/by/4.0/';

  it('owns one condition on its leaf, and reports its value as selected', () => {
    const own = {
      or: [
        {
          field: 'associatedMedia',
          entry: [{ field: 'license', in: [CC_BY] }],
        },
      ],
    };
    const [search] = facetSearches({ ...base, where: [own] });

    expect(search).toMatchObject({
      own: 'associatedMedia.license',
      selected: { 'associatedMedia.license': [CC_BY] },
    });
    expect(search?.query.where).toEqual([]);
  });

  it('owns nothing welded to another leaf, which constrains two parts of one entry', () => {
    const welded = {
      or: [
        {
          field: 'associatedMedia',
          entry: [
            { field: 'license', in: [CC_BY] },
            { field: 'encodingFormat', in: ['image/jpeg'] },
          ],
        },
      ],
    };
    const searches = facetSearches({ ...base, where: [welded] });

    expect(searches).toHaveLength(1);
    expect(searches[0]?.own).toBeUndefined();
    expect(searches[0]?.query.where).toEqual([welded]);
  });
});

describe('the facet names a typed declaration admits', () => {
  it('includes each faceted leaf by its path', () => {
    const typed = defineSearchType({
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
          ref: {
            strategy: 'inline',
            typeName: 'MediaObject',
            facetedLeaves: ['license'],
          },
        },
      ],
    });
    const admitted: FacetFieldsOf<typeof typed> = 'associatedMedia.license';
    // @ts-expect-error – not a faceted leaf
    const refused: FacetFieldsOf<typeof typed> =
      'associatedMedia.encodingFormat';

    expect([typed.name, admitted, refused]).toHaveLength(3);
  });
});

describe('the clause that selects a bucket', () => {
  const work = workFaceting(['license', 'encodingFormat']);
  const schema = searchSchema(work, mediaObject);
  const facet = (name: string) =>
    facetNamed(work, name, schema) as ReturnType<typeof facetsOf>[number];

  it('welds a faceted leaf’s value to one entry, the clause its facet owns', () => {
    const clause = selectionOf(facet('associatedMedia.license'), 'x');

    expect(clause).toEqual({
      or: [
        { field: 'associatedMedia', entry: [{ field: 'license', in: ['x'] }] },
      ],
    });
    expect(
      facetSearches({
        where: [clause],
        orderBy: [],
        limit: 10,
        offset: 0,
        facets: ['associatedMedia.license'],
        locale: 'nl',
      })[0]?.own,
    ).toBe('associatedMedia.license');
  });

  it('selects a boolean by `is` and a field of its own directly', () => {
    const flags = defineSearchType({
      name: 'Flagged',
      class: `${SCHEMA_ORG}Thing`,
      fields: [
        {
          name: 'hasMedia',
          kind: 'boolean',
          path: `${SCHEMA_ORG}isFamilyFriendly`,
          facetable: true,
          filterable: true,
        },
      ],
    });
    const flagSchema = searchSchema(flags);
    expect(
      selectionOf(
        facetNamed(flags, 'hasMedia', flagSchema) as ReturnType<
          typeof facetsOf
        >[number],
        'true',
      ),
    ).toEqual({ or: [{ field: 'hasMedia', is: true }] });
  });
});
