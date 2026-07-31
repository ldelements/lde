import { describe, expect, it } from 'vitest';
import { defineSearchType, searchSchema, type SearchType } from '@lde/search';
import { buildCollectionDefinition } from '../src/collection-definition.js';

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
      path: 'https://def.nde.nl/format',
      kind: 'keyword',
      array: true,
      facetable: true,
    },
    // Derived fields (no path) still get collection fields – populated at index
    // time by `derive` functions, not projected.
    { name: 'status', kind: 'keyword', facetable: true, required: true },
    { name: 'statusRank', kind: 'integer', sortable: true },
    {
      name: 'size',
      kind: 'integer',
      facetable: true,
      sortable: true,
    },
    { name: 'iiif', kind: 'boolean', facetable: true },
    {
      name: 'publisher',
      path: 'http://purl.org/dc/terms/publisher',
      kind: 'reference',
      array: true,
      facetable: true,
    },
    {
      name: 'datePosted',
      path: 'https://def.nde.nl/datePosted',
      kind: 'date',
      sortable: true,
    },
    {
      name: 'score',
      kind: 'number',
      facetable: true,
    },
  ],
};

describe('buildCollectionDefinition', () => {
  const collection = buildCollectionDefinition(schema, {
    name: 'datasets',
    defaultLocale: 'nl',
    defaultSortingField: 'statusRank',
    synonymSets: ['dataset-synonyms'],
  });

  it('carries the collection name, default sorting field and synonym sets', () => {
    expect(collection.name).toBe('datasets');
    expect(collection.default_sorting_field).toBe('statusRank');
    expect(collection.synonym_sets).toEqual(['dataset-synonyms']);
  });

  it('fans a localized text field into a regex display field, per-locale stemmed search and sort keys', () => {
    // Display: one un-indexed regex field capturing every present language
    // (`title_<lang>`), not an enumerated per-locale pair.
    expect(collection.fields).toContainEqual({
      name: 'title_[^_]+',
      type: 'string',
      index: false,
      optional: true,
    });
    expect(collection.fields).not.toContainEqual(
      expect.objectContaining({ name: 'title_nl' }),
    );
    expect(collection.fields).toContainEqual({
      name: 'title_search_nl',
      type: 'string',
      optional: true,
      stem: true,
      locale: 'nl',
    });
    expect(collection.fields).toContainEqual({
      name: 'title_search_en',
      type: 'string',
      optional: true,
      stem: true,
      locale: 'en',
    });
    expect(collection.fields).toContainEqual({
      name: 'title_sort_nl',
      type: 'string',
      sort: true,
      optional: true,
    });
    expect(collection.fields).toContainEqual({
      name: 'title_sort_en',
      type: 'string',
      sort: true,
      optional: true,
    });
  });

  it('maps keyword/reference/integer/boolean kinds to Typesense value fields', () => {
    expect(collection.fields).toContainEqual({
      name: 'keyword',
      type: 'string[]',
      facet: true,
      sort: false,
      optional: true,
    });
    // `status` is required → non-optional, like the default sorting field.
    expect(collection.fields).toContainEqual({
      name: 'status',
      type: 'string',
      facet: true,
      sort: false,
      optional: false,
    });
    // statusRank is the default_sorting_field, which Typesense requires to be
    // non-optional.
    expect(collection.fields).toContainEqual({
      name: 'statusRank',
      type: 'int64',
      facet: false,
      sort: true,
      optional: false,
    });
    expect(collection.fields).toContainEqual({
      name: 'size',
      type: 'int64',
      facet: true,
      sort: true,
      optional: true,
    });
    expect(collection.fields).toContainEqual({
      name: 'iiif',
      type: 'bool',
      facet: true,
      sort: false,
      optional: true,
    });
    expect(collection.fields).toContainEqual({
      name: 'publisher',
      type: 'string[]',
      facet: true,
      sort: false,
      optional: true,
    });
    expect(collection.fields).toContainEqual({
      name: 'datePosted',
      type: 'int64',
      facet: false,
      sort: true,
      optional: true,
    });
    expect(collection.fields).toContainEqual({
      name: 'score',
      type: 'float',
      facet: true,
      sort: false,
      optional: true,
    });
  });

  it('emits a folded, stemmed search companion for a searchable keyword field', () => {
    expect(collection.fields).toContainEqual({
      name: 'keyword_search',
      type: 'string[]',
      optional: true,
      stem: true,
      locale: 'nl',
    });
  });

  it('assumes no language: without defaultLocale the companion is folded but unstemmed', () => {
    const withoutLocale = buildCollectionDefinition(schema, {
      name: 'datasets',
    });
    expect(withoutLocale.fields).toContainEqual({
      name: 'keyword_search',
      type: 'string[]',
      optional: true,
    });
    // Localized text still stems per locale – that never depended on the default.
    expect(withoutLocale.fields).toContainEqual(
      expect.objectContaining({ name: 'title_search_nl', locale: 'nl' }),
    );
  });
});

describe('und-locale text', () => {
  it('folds the und search field, stemming only via the default locale', () => {
    const schema = buildCollectionDefinition(
      {
        name: 'Doc',
        class: 'urn:example:Doc',
        fields: [
          {
            name: 'summary',
            kind: 'text',
            locales: ['und'],
            output: true,
            sortable: true,
            searchable: { weight: 1 },
          },
        ],
      },
      { name: 'docs', defaultLocale: 'en' },
    );
    expect(schema.fields).toEqual([
      { name: 'summary_[^_]+', type: 'string', index: false, optional: true },
      {
        name: 'summary_search_und',
        type: 'string',
        optional: true,
        stem: true,
        locale: 'en',
      },
      { name: 'summary_sort_und', type: 'string', sort: true, optional: true },
    ]);
  });

  it('emits no display field for a search-only (non-output) text field', () => {
    const schema = buildCollectionDefinition(
      {
        name: 'Doc',
        class: 'urn:example:Doc',
        fields: [
          {
            name: 'creator',
            kind: 'text',
            locales: ['nl'],
            searchable: { weight: 1 },
          },
        ],
      },
      { name: 'docs' },
    );
    // Display is gated on `output`; a search-only field emits only its folded
    // search companion, no `${name}_<lang>` regex field.
    expect(schema.fields).toEqual([
      {
        name: 'creator_search_nl',
        type: 'string',
        optional: true,
        stem: true,
        locale: 'nl',
      },
    ]);
  });
});

describe('internal fields', () => {
  it('omits an internal (zero-role) field of every kind from the collection', () => {
    const collection = buildCollectionDefinition(
      {
        name: 'Doc',
        class: 'urn:example:Doc',
        fields: [
          { name: 'token', path: 'urn:ex:token', kind: 'keyword' },
          { name: 'ref', path: 'urn:ex:ref', kind: 'reference' },
          { name: 'count', path: 'urn:ex:count', kind: 'integer' },
          { name: 'score', path: 'urn:ex:score', kind: 'number' },
          { name: 'flag', path: 'urn:ex:flag', kind: 'boolean' },
          { name: 'note', path: 'urn:ex:note', kind: 'text', locales: ['nl'] },
        ],
      },
      { name: 'docs' },
    );
    // Every field declares no role, so it is internal – a projection-time
    // reading device, pruned before the writer. The collection stores nothing
    // for any of them: not stored, not indexed, no RAM.
    expect(collection.fields).toEqual([]);
  });

  it('keeps a field the moment it declares any role', () => {
    const collection = buildCollectionDefinition(
      {
        name: 'Doc',
        class: 'urn:example:Doc',
        fields: [
          { name: 'hidden', path: 'urn:ex:hidden', kind: 'keyword' },
          {
            name: 'shown',
            path: 'urn:ex:shown',
            kind: 'keyword',
            facetable: true,
          },
        ],
      },
      { name: 'docs' },
    );
    // Only the field carrying a role reaches the collection.
    expect(collection.fields).toEqual([
      {
        name: 'shown',
        type: 'string',
        facet: true,
        sort: false,
        optional: true,
      },
    ]);
  });
});

describe('surfaced inline references', () => {
  const mediaObject = defineSearchType({
    name: 'MediaObject',
    fields: [
      {
        name: 'contentUrl',
        kind: 'keyword',
        array: true,
        output: true,
        path: 'https://schema.org/contentUrl',
      },
      {
        name: 'width',
        kind: 'integer',
        output: true,
        path: 'https://schema.org/width',
      },
      {
        name: 'caption',
        kind: 'text',
        locales: ['nl'],
        output: true,
        path: 'https://schema.org/caption',
      },
      // No role: the reading device an inline reference is the other half of.
      { name: 'rawWidth', kind: 'keyword', path: 'https://schema.org/width' },
    ],
  });

  const creativeWorkWith = (media: Record<string, unknown>) =>
    defineSearchType({
      name: 'CreativeWork',
      class: 'https://schema.org/CreativeWork',
      fields: [
        {
          name: 'media',
          kind: 'reference',
          output: true,
          path: 'https://schema.org/associatedMedia',
          ref: { typeName: 'MediaObject', strategy: 'inline' },
          ...media,
        },
      ],
    });

  const definitionFor = (media: Record<string, unknown>) => {
    const creativeWork = creativeWorkWith(media);
    return buildCollectionDefinition(creativeWork, {
      name: 'works',
      schema: searchSchema(creativeWork, mediaObject),
    });
  };

  it('stores a multi-valued inline reference as one nested object per referent', () => {
    const collection = definitionFor({ array: true });
    // `object[]` – each referent keeps its own values grouped, so a consumer
    // never pairs parallel arrays by index. Everything nested is un-indexed:
    // a nested field carries `output` only, so it is display weight on disk.
    expect(collection.fields).toEqual([
      { name: 'media', type: 'object[]', index: false, optional: true },
      {
        name: 'media.contentUrl',
        type: 'string[]',
        index: false,
        optional: true,
      },
      { name: 'media.width', type: 'int64', index: false, optional: true },
      // A nested text field stores its display values exactly as a root one
      // does – one field per present language, matched by one pattern.
      {
        name: 'media.caption_[^_]+',
        type: 'string',
        index: false,
        optional: true,
      },
    ]);
    // The nested object types are what turn nesting on; Typesense rejects them
    // otherwise.
    expect(collection.enable_nested_fields).toBe(true);
  });

  it('stores a single-valued inline reference as one nested object', () => {
    expect(definitionFor({}).fields?.[0]).toEqual({
      name: 'media',
      type: 'object',
      index: false,
      optional: true,
    });
    expect(definitionFor({ required: true }).fields?.[0]).toEqual({
      name: 'media',
      type: 'object',
      index: false,
      optional: false,
    });
  });

  it('contributes nothing for an internal field inside a reference type', () => {
    // `rawWidth` declares no role, so the invariant *a field without a role
    // reaches neither the engine nor the API* holds at nesting depth too.
    expect(definitionFor({}).fields).not.toContainEqual(
      expect.objectContaining({ name: 'media.rawWidth' }),
    );
  });

  it('nests a reference type that itself surfaces an inline reference', () => {
    const thumbnail = defineSearchType({
      name: 'Thumbnail',
      fields: [
        {
          name: 'contentUrl',
          kind: 'keyword',
          array: true,
          output: true,
          path: 'https://schema.org/contentUrl',
        },
      ],
    });
    const media = defineSearchType({
      name: 'MediaObject',
      fields: [
        {
          name: 'thumbnail',
          kind: 'reference',
          array: true,
          output: true,
          path: 'https://schema.org/thumbnail',
          ref: { typeName: 'Thumbnail', strategy: 'inline' },
        },
      ],
    });
    const creativeWork = creativeWorkWith({});
    const collection = buildCollectionDefinition(creativeWork, {
      name: 'works',
      schema: searchSchema(creativeWork, media, thumbnail),
    });
    expect(collection.fields).toEqual([
      { name: 'media', type: 'object', index: false, optional: true },
      {
        name: 'media.thumbnail',
        type: 'object[]',
        index: false,
        optional: true,
      },
      {
        name: 'media.thumbnail.contentUrl',
        type: 'string[]',
        index: false,
        optional: true,
      },
    ]);
  });

  it('rejects building a collection for a nesting type without its schema', () => {
    // Without the schema the nesting is invisible: the collection would declare
    // the reference as a string the projection never writes, and every document
    // would fail to import. Fail where the collection is built instead.
    expect(() =>
      buildCollectionDefinition(creativeWorkWith({}), { name: 'works' }),
    ).toThrow(/needs the search schema.*“media”/);
  });

  it('leaves a reading-device inline reference out of the collection', () => {
    // No role: pruned before the writer, so nothing is stored – no nested
    // object, and no nesting flag on the collection.
    const creativeWork = defineSearchType({
      name: 'CreativeWork',
      class: 'https://schema.org/CreativeWork',
      fields: [
        {
          name: 'media',
          kind: 'reference',
          path: 'https://schema.org/associatedMedia',
          ref: { typeName: 'MediaObject', strategy: 'inline' },
        },
      ],
    });
    const collection = buildCollectionDefinition(creativeWork, {
      name: 'works',
      schema: searchSchema(creativeWork, mediaObject),
    });
    expect(collection.fields).toEqual([]);
    expect(collection.enable_nested_fields).toBeUndefined();
  });
});
