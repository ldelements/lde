import { describe, expect, it } from 'vitest';
import { defineSearchType, searchSchema } from '@lde/search';
import { labelTargetNameOf } from '@lde/search/adapter';
import { buildCollectionDefinition } from '../src/collection-definition.js';
import { buildSearchParams } from '../src/query-compiler.js';

const SCHEMA_ORG = 'https://schema.org/';

const person = defineSearchType({
  name: 'Person',
  class: `${SCHEMA_ORG}Person`,
  fields: [
    {
      name: 'label',
      kind: 'text',
      path: `${SCHEMA_ORG}name`,
      locales: ['und'],
      output: true,
      searchable: { weight: 1 },
    },
  ],
});

/** The edge: a value of its own, an exact-matchable name, and the endpoint. */
const creatorEdge = defineSearchType({
  name: 'CreatorEdge',
  fields: [
    {
      name: 'role',
      kind: 'keyword',
      path: `${SCHEMA_ORG}name`,
      output: true,
    },
    {
      name: 'name',
      kind: 'keyword',
      path: `<${SCHEMA_ORG}creator>/<${SCHEMA_ORG}name>`,
      output: true,
      filterable: true,
    },
    {
      name: 'creator',
      kind: 'reference',
      path: `${SCHEMA_ORG}creator`,
      output: true,
      ref: { strategy: 'lookup', target: 'Person', local: true },
    },
  ],
});

const work = defineSearchType({
  name: 'Work',
  class: `${SCHEMA_ORG}CreativeWork`,
  fields: [
    {
      name: 'creator',
      kind: 'reference',
      path: `${SCHEMA_ORG}creator`,
      array: true,
      output: true,
      filterable: true,
      facetable: true,
      ref: { strategy: 'inline', typeName: 'CreatorEdge', identity: 'creator' },
    },
  ],
});

const schema = searchSchema(work, person, creatorEdge);
const fieldsOf = () => buildCollectionDefinition(work, { schema }).fields ?? [];
const named = (name: string) => fieldsOf().find((field) => field.name === name);

describe('the collection an edge is stored in', () => {
  it('indexes the parent object whenever a child is indexed', () => {
    // The one silent failure in Typesense 30.2: an indexed child under an
    // `index: false` parent is ignored – no error, and every query answering
    // empty. So the parent’s flag follows its children rather than a default.
    expect(named('creator')).toMatchObject({
      type: 'object[]',
      index: true,
    });
  });

  it('leaves a display-only nested field out of the index', () => {
    // `role` declares `output` alone, so it stays disk weight: stored with its
    // entry, read back with it, costing no memory.
    expect(named('creator.role')).toMatchObject({ index: false });
  });

  it('indexes a nested field that declares a query Role, as an array', () => {
    // Under an `object[]`, a value arrives as a list however single-valued its
    // declaration – and an indexed field’s type is checked against what is
    // stored, unlike an unindexed one.
    expect(named('creator.name')).toMatchObject({
      type: 'string[]',
      index: true,
    });
  });

  it('emits the identity companion as a flat, facetable id field', () => {
    // A nested object is not something an engine filters or facets; this is
    // the flat field it filters and facets in its place.
    expect(named('creator_id')).toMatchObject({
      type: 'string[]',
      facet: true,
    });
  });

  it('declares the id a local lookup stores, which no type declares itself', () => {
    expect(named('creator.creator.id')).toMatchObject({ index: false });
  });

  it('turns on nested fields, since it declares an object', () => {
    expect(
      buildCollectionDefinition(work, { schema }).enable_nested_fields,
    ).toBe(true);
  });

  it('declares a nested object inside a multi-valued one as a list too', () => {
    // The endpoint is single-valued on the edge, but the edge is not: an engine
    // flattens the nesting, so the objects arrive as a list. Declared `object`,
    // that mismatches what is stored the moment a descendant is indexed.
    expect(named('creator.creator')).toMatchObject({ type: 'object[]' });
  });
});

describe('nested fields of other kinds', () => {
  // One edge carrying each shape the fanout has to handle: a searchable
  // keyword (its own folded companion), and an indexed numeric (whose type is
  // widened by the `object[]` above it).
  const richEdge = defineSearchType({
    name: 'RichEdge',
    fields: [
      {
        name: 'note',
        kind: 'keyword',
        path: `${SCHEMA_ORG}description`,
        output: true,
        searchable: { weight: 1 },
      },
      {
        name: 'position',
        kind: 'integer',
        path: `${SCHEMA_ORG}position`,
        output: true,
        filterable: true,
      },
      {
        name: 'certainty',
        kind: 'number',
        path: `${SCHEMA_ORG}ratingValue`,
        output: true,
        filterable: true,
      },
      {
        name: 'disputed',
        kind: 'boolean',
        path: `${SCHEMA_ORG}disambiguatingDescription`,
        output: true,
        filterable: true,
      },
      {
        name: 'source',
        kind: 'keyword',
        path: `${SCHEMA_ORG}isBasedOn`,
        array: true,
        output: true,
        filterable: true,
      },
    ],
  });
  const richWork = defineSearchType({
    name: 'Work',
    class: `${SCHEMA_ORG}CreativeWork`,
    fields: [
      {
        name: 'credit',
        kind: 'reference',
        path: `${SCHEMA_ORG}creator`,
        array: true,
        output: true,
        ref: { strategy: 'inline', typeName: 'RichEdge' },
      },
    ],
  });
  const richSchema = searchSchema(richWork, richEdge);
  const richField = (name: string) =>
    (
      buildCollectionDefinition(richWork, { schema: richSchema }).fields ?? []
    ).find((field) => field.name === name);

  it('gives a searchable nested keyword its folded companion', () => {
    expect(richField('credit.note_search')).toMatchObject({
      type: 'string[]',
    });
  });

  it.each([
    ['credit.position', 'int64[]'],
    ['credit.certainty', 'float[]'],
    ['credit.disputed', 'bool[]'],
    // Already a list on its own: flattening does not double it.
    ['credit.source', 'string[]'],
  ])('widens indexed nested %s to %s', (name, type) => {
    // An engine checks an indexed field's declared type against what is
    // stored, and the `object[]` above these flattens each value into a list.
    expect(richField(name)).toMatchObject({ type, index: true });
  });
});

describe('a facet policy over the companion', () => {
  it('facets the narrowed companion rather than the companion itself', () => {
    // The policy belongs to the endpoint's type and is inherited through the
    // identity, so the engine facets a second field holding only the admitted
    // ids – never seeing an excluded one.
    const narrowed = defineSearchType({
      ...person,
      facetKeys: { only: (id: string) => id.startsWith('https://ok/') },
    });
    const fields =
      buildCollectionDefinition(work, {
        schema: searchSchema(work, narrowed, creatorEdge),
      }).fields ?? [];

    expect(
      fields.find((field) => field.name === 'creator_id_facet'),
    ).toMatchObject({ facet: true });
    expect(fields.find((field) => field.name === 'creator_id')).toMatchObject({
      facet: false,
    });
  });
});

describe('labelling the buckets of an edge’s facet', () => {
  it('reads the label target through the identity companion', () => {
    // An inline reference names no label source of its own, so reading only
    // `labelSourceNameOf` left its buckets unlabelled – the facet policy was
    // inherited one level in, but the labels were not.
    expect(labelTargetNameOf(work.fields[0], schema)).toBe('Person');
  });

  it('names nothing for an inline reference without an identity', () => {
    const displayOnly = defineSearchType({
      name: 'Display',
      class: `${SCHEMA_ORG}CreativeWork`,
      fields: [
        {
          name: 'creator',
          kind: 'reference',
          path: `${SCHEMA_ORG}creator`,
          array: true,
          output: true,
          ref: { strategy: 'inline', typeName: 'CreatorEdge' },
        },
      ],
    });

    expect(
      labelTargetNameOf(
        displayOnly.fields[0],
        searchSchema(displayOnly, person, creatorEdge),
      ),
    ).toBeUndefined();
  });
});

describe('compiling a filter over an edge', () => {
  const base = {
    where: [],
    orderBy: [],
    limit: 10,
    offset: 0,
    facets: [],
    locale: 'nl',
  } as const;

  it('filters an inline reference through its identity companion', () => {
    // The logical name a consumer writes is `creator`; the physical field the
    // engine reads is the companion. This is the one place the two differ.
    //
    // `:` rather than `:=` because the companion is the facet field, and a
    // facet field is stored whole rather than tokenized – so `:` is already
    // exact on it. The same reading every facetable reference gets.
    const params = buildSearchParams(
      {
        ...base,
        where: [{ or: [{ field: 'creator', in: ['https://id.example/1'] }] }],
      },
      work,
      { schema },
    );

    expect(params.filter_by).toBe('creator_id:[`https://id.example/1`]');
  });

  it('qualifies a nested field with the path walked to reach it', () => {
    const params = buildSearchParams(
      {
        ...base,
        where: [
          { or: [{ on: ['creator'], field: 'name', in: ['Jan Jansen'] }] },
        ],
      },
      work,
      { schema },
    );

    expect(params.filter_by).toBe('creator.name:=[`Jan Jansen`]');
  });

  it('matches nothing for a criterion whose path does not resolve', () => {
    // Through the engine `assertValidQuery` rejects this first. Compiled
    // directly, a clause whose every criterion is unusable matches nothing –
    // never dropped, which would silently widen the query instead.
    const params = buildSearchParams(
      {
        ...base,
        where: [{ or: [{ on: ['nope'], field: 'name', in: ['x'] }] }],
      },
      work,
      { schema },
    );

    expect(params.filter_by).toBe('id:=[]');
  });

  it('facets an inline reference on its companion', () => {
    const params = buildSearchParams({ ...base, facets: ['creator'] }, work, {
      schema,
    });

    expect(params.facet_by).toBe('creator_id');
  });
});
