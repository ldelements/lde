import { describe, expect, it } from 'vitest';
import { graphql, printSchema } from 'graphql';
import {
  defineSearchType,
  searchSchema,
  type SearchEngine,
  type SearchQuery,
  type SearchResult,
  type SearchType,
} from '@lde/search';
import { buildGraphQLSchema, type SearchContext } from '../src/build-schema.js';

const SCHEMA_ORG = 'https://schema.org/';
const CC_BY = 'https://creativecommons.org/licenses/by/4.0/';

const mediaObject = defineSearchType({
  name: 'MediaObject',
  fields: [
    {
      name: 'license',
      kind: 'reference',
      output: true,
      filterable: true,
      ref: { strategy: 'idOnly' },
    },
    { name: 'thumbnailUrl', kind: 'keyword', output: true },
    {
      name: 'encodingFormat',
      kind: 'keyword',
      output: true,
      filterable: true,
    },
  ],
});

const work = defineSearchType({
  name: 'Work',
  class: `${SCHEMA_ORG}CreativeWork`,
  fields: [
    { name: 'title', kind: 'text', locales: ['nl'], output: true },
    {
      name: 'associatedMedia',
      kind: 'reference',
      array: true,
      output: true,
      filterable: true,
      ref: {
        strategy: 'inline',
        typeName: 'MediaObject',
        facetedLeaves: ['license'],
        presenceLeaves: ['thumbnailUrl', 'encodingFormat'],
      },
    },
  ],
});

const schema = searchSchema(work, mediaObject);
const gqlSchema = buildGraphQLSchema(schema, {});
const printed = printSchema(gqlSchema);

function recordingEngine() {
  const searched: SearchQuery[] = [];
  const faceted: SearchQuery[] = [];
  const engine: SearchEngine = {
    schema,
    async search(_searchType: SearchType, query: SearchQuery) {
      searched.push(query);
      return { total: 0, hits: [], facets: {} } as SearchResult;
    },
    async searchFacets(_searchType, queries) {
      faceted.push(...queries);
      return queries.map(() => ({
        facets: {
          'associatedMedia.license': {
            buckets: [{ value: CC_BY, count: 2 }],
          },
          'associatedMedia.thumbnailUrl.exists': {
            buckets: [
              { value: 'false', count: 2, is: false },
              { value: 'true', count: 1, is: true },
            ],
          },
        },
      })) as never;
    },
  };
  return { engine, searched, faceted };
}

async function run(source: string) {
  const recording = recordingEngine();
  const response = await graphql({
    schema: gqlSchema,
    source,
    contextValue: {
      engine: recording.engine,
      acceptLanguage: ['nl'],
    } as SearchContext,
  });
  return { response, ...recording };
}

describe('a root document filtered on whether an entry’s leaf has a value', () => {
  it('gives a presence leaf `exists` in the reference type’s where', () => {
    expect(printed).toMatch(
      /input MediaObjectWhere \{[^}]*license: IRIFilter\n[^}]*thumbnailUrl: ExistsFilter\n[^}]*encodingFormat: KeywordFilterOrExists\n/,
    );
  });

  it('compiles `exists` into a weld of that one condition', async () => {
    const { response, searched } = await run(
      `{ works(where: { associatedMedia: { where: { thumbnailUrl: { exists: true } } } }) { pagination { total } } }`,
    );

    expect(response.errors).toBeUndefined();
    expect(searched[0]?.where).toEqual([
      {
        or: [
          {
            field: 'associatedMedia',
            entry: [{ field: 'thumbnailUrl', exists: true }],
          },
        ],
      },
    ]);
  });

  it('reads a filterable presence leaf’s value when `exists` is unset', async () => {
    const { response, searched } = await run(
      `{ works(where: { associatedMedia: { where: { encodingFormat: { in: ["image/png"] } } } }) { pagination { total } } }`,
    );

    expect(response.errors).toBeUndefined();
    expect(searched[0]?.where).toEqual([
      {
        or: [
          {
            field: 'associatedMedia',
            entry: [{ field: 'encodingFormat', in: ['image/png'] }],
          },
        ],
      },
    ]);
  });

  it('refuses `exists` welded to another condition, naming the rewrite', async () => {
    const { response, searched } = await run(
      `{ works(where: { associatedMedia: { where: { thumbnailUrl: { exists: true }, license: { in: ["${CC_BY}"] } } } }) { pagination { total } } }`,
    );

    expect(searched).toEqual([]);
    expect(response.errors?.[0]?.message).toMatch(
      /“associatedMedia” welds “exists” on “thumbnailUrl” to “license” on one entry.*and: \[\{ associatedMedia: \{ where: \{ thumbnailUrl: \{ exists: true \} \} \} \}, \{ associatedMedia: \{ where: \{ license: … \} \} \}\]/,
    );
    expect(response.errors?.[0]?.extensions?.code).toBe('BAD_USER_INPUT');
  });
});

describe('a root document faceted on whether an entry’s leaf has a value', () => {
  it('serves the facet under the leaf, beside the reference’s faceted leaves', () => {
    expect(printed).toMatch(
      /type WorkAssociatedMediaFacets \{[^}]*\): IRIFacet!\s*thumbnailUrl: WorkAssociatedMediaThumbnailUrlFacets!\s*encodingFormat: WorkAssociatedMediaEncodingFormatFacets!\s*\}/,
    );
    expect(printed).toMatch(
      /type WorkAssociatedMediaThumbnailUrlFacets \{[^}]*exists: \[BooleanBucket!\]!\s*\}/,
    );
  });

  it('asks the engine for the facet by its path, and serves boolean buckets', async () => {
    const { response, faceted } = await run(
      `{ works { facets { associatedMedia { license { buckets { value count } } thumbnailUrl { exists { value count } } } } } }`,
    );

    expect(response.errors).toBeUndefined();
    expect(faceted.map((query) => query.facets)).toEqual([
      ['associatedMedia.license', 'associatedMedia.thumbnailUrl.exists'],
    ]);
    expect(response.data).toEqual({
      works: {
        facets: {
          associatedMedia: {
            license: { buckets: [{ value: CC_BY, count: 2 }] },
            thumbnailUrl: {
              exists: [
                { value: false, count: 2 },
                { value: true, count: 1 },
              ],
            },
          },
        },
      },
    });
  });
});

describe('a reference with presence leaves on a joined type', () => {
  const joined = defineSearchType({
    name: 'Collection',
    class: `${SCHEMA_ORG}Collection`,
    fields: [
      {
        name: 'label',
        kind: 'text',
        locales: ['nl'],
        output: true,
        searchable: { weight: 1 },
      },
      {
        name: 'associatedMedia',
        kind: 'reference',
        array: true,
        filterable: true,
        ref: {
          strategy: 'inline',
          typeName: 'MediaObject',
          presenceLeaves: ['thumbnailUrl', 'encodingFormat'],
        },
      },
    ],
  });
  const member = defineSearchType({
    name: 'Item',
    class: `${SCHEMA_ORG}Thing`,
    fields: [
      {
        name: 'collection',
        kind: 'reference',
        filterable: true,
        labelSource: 'Collection',
        joinable: true,
      },
    ],
  });
  const joinedPrinted = printSchema(
    buildGraphQLSchema(searchSchema(joined, member, mediaObject), {}),
  );

  it('reaches the entries through a join without `exists`, which no join reads', () => {
    expect(joinedPrinted).toMatch(
      /input CollectionJoinedWhere \{[^}]*associatedMedia: MediaObjectJoinedFilter\n/,
    );
    const where = /input MediaObjectJoinedWhere \{([^}]*)\}/.exec(
      joinedPrinted,
    );
    expect(where?.[1]).toMatch(/encodingFormat: KeywordFilter\n/);
    expect(where?.[1]).not.toMatch(/thumbnailUrl|exists|OrExists/);
    expect(joinedPrinted).toMatch(
      /input CollectionWhere \{[^}]*associatedMedia: MediaObjectFilter\n/,
    );
  });
});

describe('the names a presence leaf adds', () => {
  const clashing = (name: string) =>
    defineSearchType({
      name,
      class: `${SCHEMA_ORG}Thing`,
      fields: [
        {
          name: 'label',
          kind: 'text',
          locales: ['nl'],
          output: true,
          searchable: { weight: 1 },
        },
      ],
    });

  it('refuses a type that takes the name of a leaf’s facet object', () => {
    expect(() =>
      printSchema(
        buildGraphQLSchema(
          searchSchema(
            work,
            mediaObject,
            clashing('WorkAssociatedMediaThumbnailUrlFacets'),
          ),
          {},
        ),
      ),
    ).toThrow(
      /“WorkAssociatedMediaThumbnailUrlFacets”, the type name of the presence facet of “associatedMedia.thumbnailUrl.exists”, is already the name of another type/,
    );
  });

  it('refuses a type that takes the name of a join variant', () => {
    const item = defineSearchType({
      name: 'Item',
      class: `${SCHEMA_ORG}Product`,
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
    const labelled = defineSearchType({
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
    });
    expect(() =>
      printSchema(
        buildGraphQLSchema(
          searchSchema(
            labelled,
            item,
            mediaObject,
            clashing('MediaObjectJoinedFilter'),
          ),
          {},
        ),
      ),
    ).toThrow(
      /“MediaObjectJoinedFilter”, the type name of the filter on “MediaObject” through a join, is already the name of another type/,
    );
  });
});
