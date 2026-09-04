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
      // Earns the identity companion an engine welds a condition on.
      filterable: true,
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

describe('a single-valued edge', () => {
  // The arity that no other test covers, and the one where a declared type can
  // disagree with what is stored.
  const singleWork = defineSearchType({
    name: 'Work',
    class: `${SCHEMA_ORG}CreativeWork`,
    fields: [
      {
        name: 'creator',
        kind: 'reference',
        path: `${SCHEMA_ORG}creator`,
        output: true,
        filterable: true,
        ref: {
          strategy: 'inline',
          typeName: 'CreatorEdge',
          identity: 'creator',
        },
      },
    ],
  });
  const singleSchema = searchSchema(singleWork, person, creatorEdge);

  it('declares the nested identity companion as a single value', () => {
    // Nothing flattens the path under a single-valued edge – the parent is
    // `object`, not `object[]` – and the companion holds one id per entry
    // (ADR 26). Declaring `string[]` here is what rejects the document: checked
    // against a live engine, the import fails outright, because Typesense
    // enforces the declared arity wherever no ancestor widens it.
    const fields =
      buildCollectionDefinition(singleWork, { schema: singleSchema }).fields ??
      [];

    expect(
      fields.find((field) => field.name === 'creator.creator_id'),
    ).toMatchObject({ type: 'string', index: true });
  });
});

describe('a local lookup that reaches back', () => {
  it('builds a collection rather than recursing forever', () => {
    // `searchSchema` rejects INLINE cycles; a `local` lookup may reach a type
    // that reaches back, and without a guard the builder recurses until the
    // stack gives out.
    const knowing = defineSearchType({
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
        {
          name: 'knows',
          kind: 'reference',
          path: `${SCHEMA_ORG}knows`,
          output: true,
          ref: { strategy: 'lookup', target: 'Person', local: true },
        },
      ],
    });
    const fields =
      buildCollectionDefinition(knowing, {
        schema: searchSchema(knowing),
      }).fields ?? [];

    // One level of nesting, then the boundary – the same depth the frame
    // reaches. The cut field itself is still declared, because the extraction
    // falls back to the referent there and the projection stores it as an
    // `{id}` object; only the descent past it stops.
    expect(fields.some((field) => field.name.startsWith('knows.'))).toBe(true);
    expect(fields.find((field) => field.name === 'knows.knows')).toMatchObject({
      type: 'object',
      index: false,
    });
    expect(
      fields.find((field) => field.name === 'knows.knows.id'),
    ).toMatchObject({ type: 'string', index: false });
    expect(
      fields.some((field) => field.name.startsWith('knows.knows.knows')),
    ).toBe(false);
  });

  it.each([
    { multiValued: false, object: 'object', scalar: 'string' },
    { multiValued: true, object: 'object[]', scalar: 'string[]' },
  ])(
    'declares the key the extraction falls back to at the cut (array: $multiValued)',
    ({ multiValued, object, scalar }) => {
      // Two Root Types whose `local` lookups reach each other. The extraction
      // stops expanding at the type already on the path and emits the target's
      // KEY hop instead, which `inlineFramingDepth` frames – so a value lands at
      // `creator.made`, and the leaf a filter welds on lands beside it. Declaring
      // nothing there left the writer filling fields the collection never
      // mentioned.
      const maker = defineSearchType({
        name: 'Person',
        class: `${SCHEMA_ORG}Person`,
        labelField: 'label',
        fields: [
          {
            name: 'label',
            kind: 'text',
            path: `${SCHEMA_ORG}name`,
            locales: ['und'],
            output: true,
            searchable: { weight: 1 },
          },
          {
            name: 'made',
            kind: 'reference',
            path: `${SCHEMA_ORG}makesOffer`,
            output: true,
            filterable: true,
            ref: { strategy: 'lookup', target: 'Work', local: true },
          },
        ],
      });
      const madeWork = defineSearchType({
        name: 'Work',
        class: `${SCHEMA_ORG}CreativeWork`,
        labelField: 'label',
        key: { field: '_sameAs' },
        fields: [
          {
            name: 'label',
            kind: 'text',
            path: `${SCHEMA_ORG}name`,
            locales: ['und'],
            output: true,
            searchable: { weight: 1 },
          },
          {
            name: '_sameAs',
            kind: 'reference',
            array: true,
            path: `${SCHEMA_ORG}sameAs`,
          },
          {
            name: 'creator',
            kind: 'reference',
            array: multiValued,
            path: `${SCHEMA_ORG}creator`,
            output: true,
            ref: { strategy: 'lookup', target: 'Person', local: true },
          },
        ],
      });
      const fields =
        buildCollectionDefinition(madeWork, {
          schema: searchSchema(madeWork, maker),
        }).fields ?? [];

      expect(
        fields.find((field) => field.name === 'creator.made'),
      ).toMatchObject({ type: object, index: false });
      expect(
        fields.find((field) => field.name === 'creator.made.id'),
      ).toMatchObject({ type: scalar, index: false });
      // The identity companion sits BESIDE the object, indexed, because that is
      // the leaf a filter can weld on – and it takes the arity of the path that
      // reaches it, exactly as the `id` above does: one id per entry (ADR 26),
      // widened only where an `object[]` ancestor multiplies the entries.
      expect(
        fields.find((field) => field.name === 'creator.made_id'),
      ).toMatchObject({ type: scalar, index: true });
      // The descent still stops: the cut type's own fields are not walked
      // again.
      expect(
        fields.some((field) => field.name.startsWith('creator.made.label')),
      ).toBe(false);
    },
  );
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
        // Output-only, so it may stay a list: nothing welds it, and a weldable
        // leaf is single-valued (ADR 26).
        name: 'source',
        kind: 'keyword',
        path: `${SCHEMA_ORG}isBasedOn`,
        array: true,
        output: true,
      },
      {
        // Searchable rather than filterable, so it may stay a list too: free
        // text is not a weld, and its folded companion is what gets indexed.
        name: 'attribution',
        kind: 'keyword',
        path: `${SCHEMA_ORG}creditText`,
        array: true,
        output: true,
        searchable: { weight: 1 },
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

  it('stems an untagged nested text field in the deployment’s locale', () => {
    // A nested text field fans out exactly as a root one does, `und` included:
    // folded, and stemmed in `defaultLocale` when the deployment sets one.
    const textEdge = defineSearchType({
      name: 'TextEdge',
      fields: [
        {
          name: 'note',
          kind: 'text',
          path: `${SCHEMA_ORG}description`,
          locales: ['und'],
          // Searchable but NOT output: indexed for free text, with no display
          // copy stored, so the entry carries only what is queried.
          searchable: { weight: 1 },
        },
      ],
    });
    const textWork = defineSearchType({
      name: 'Work',
      class: `${SCHEMA_ORG}CreativeWork`,
      fields: [
        {
          name: 'credit',
          kind: 'reference',
          path: `${SCHEMA_ORG}creator`,
          array: true,
          output: true,
          ref: { strategy: 'inline', typeName: 'TextEdge' },
        },
      ],
    });
    const fields =
      buildCollectionDefinition(textWork, {
        schema: searchSchema(textWork, textEdge),
        defaultLocale: 'nl',
      }).fields ?? [];

    expect(
      fields.find((field) => field.name === 'credit.note_search_und'),
    ).toMatchObject({ type: 'string[]', stem: true, locale: 'nl' });
    // No display copy: the field never surfaces.
    expect(fields.some((field) => field.name.startsWith('credit.note_'))).toBe(
      true,
    );
    expect(fields.filter((field) => field.name.includes('note')).length).toBe(
      1,
    );
  });

  it('stems a language-tagged nested text field in its own locale', () => {
    // The counterpart of the `und` case above: a declared locale stems in
    // itself, never in `defaultLocale`, so a Dutch note is not stemmed as if
    // it were English.
    const taggedEdge = defineSearchType({
      name: 'TaggedEdge',
      fields: [
        {
          name: 'note',
          kind: 'text',
          path: `${SCHEMA_ORG}description`,
          locales: ['nl'],
          searchable: { weight: 1 },
        },
      ],
    });
    const taggedWork = defineSearchType({
      name: 'Work',
      class: `${SCHEMA_ORG}CreativeWork`,
      fields: [
        {
          name: 'credit',
          kind: 'reference',
          path: `${SCHEMA_ORG}creator`,
          array: true,
          output: true,
          ref: { strategy: 'inline', typeName: 'TaggedEdge' },
        },
      ],
    });
    const fields =
      buildCollectionDefinition(taggedWork, {
        schema: searchSchema(taggedWork, taggedEdge),
        defaultLocale: 'en',
      }).fields ?? [];

    expect(
      fields.find((field) => field.name === 'credit.note_search_nl'),
    ).toMatchObject({ type: 'string[]', stem: true, locale: 'nl' });
  });

  it('gives a searchable nested keyword its folded companion', () => {
    expect(richField('credit.note_search')).toMatchObject({
      type: 'string[]',
    });
  });

  it.each([
    ['credit.position', 'int64[]'],
    ['credit.certainty', 'float[]'],
    ['credit.disputed', 'bool[]'],
  ])('widens indexed nested %s to %s', (name, type) => {
    // An engine checks an indexed field's declared type against what is
    // stored, and the `object[]` above these flattens each value into a list.
    expect(richField(name)).toMatchObject({ type, index: true });
  });

  it('types a nested identity companion by what its path yields', () => {
    // The companion holds one id per entry (ADR 26), so its declared type is
    // decided by the ancestors, exactly as the `id` beside it is. Declaring
    // `string[]` unconditionally makes Typesense reject, at import, every
    // document whose edge is single-valued: nothing flattens the path there,
    // and the engine enforces the declared arity.
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
    const edge = defineSearchType({
      name: 'IdentifiedEdge',
      fields: [
        {
          name: 'agent',
          kind: 'reference',
          path: `${SCHEMA_ORG}creator`,
          output: true,
          filterable: true,
          ref: { strategy: 'lookup', target: 'Person', local: true },
        },
      ],
    });
    const workWith = (array: boolean) =>
      defineSearchType({
        name: 'Work',
        class: `${SCHEMA_ORG}CreativeWork`,
        fields: [
          {
            name: 'credit',
            kind: 'reference',
            path: `${SCHEMA_ORG}creator`,
            ...(array ? { array: true } : {}),
            output: true,
            ref: { strategy: 'inline', typeName: 'IdentifiedEdge' },
          },
        ],
      });
    const companion = (array: boolean) => {
      const type = workWith(array);
      return (
        buildCollectionDefinition(type, {
          schema: searchSchema(type, person, edge),
        }).fields ?? []
      ).find((field) => field.name === 'credit.agent_id');
    };

    expect(companion(true)).toMatchObject({ type: 'string[]' });
    expect(companion(false)).toMatchObject({ type: 'string' });
  });

  it('declares a multi-valued nested companion as a list, unflattened', () => {
    // The companion's other route to a list: the reference itself is `array`,
    // so one entry harvests several ids even where no ancestor multiplies the
    // entries. Reachable through a locally-nested Root Type, whose fields the
    // single-valued rule does not constrain – and the projection writes a list
    // there, so declaring `string` rejects the document at import.
    const org = defineSearchType({
      name: 'Membership',
      fields: [
        {
          name: 'org',
          kind: 'reference',
          path: `${SCHEMA_ORG}memberOf`,
          output: true,
          ref: { strategy: 'lookup', target: 'Person' },
        },
      ],
    });
    const nestedRoot = defineSearchType({
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
        {
          name: 'affiliation',
          kind: 'reference',
          path: `${SCHEMA_ORG}affiliation`,
          array: true,
          output: true,
          filterable: true,
          ref: { strategy: 'inline', typeName: 'Membership', identity: 'org' },
        },
      ],
    });
    // Single-valued, so nothing above flattens: only the field's own `array`
    // makes this a list.
    const work = defineSearchType({
      name: 'Work',
      class: `${SCHEMA_ORG}CreativeWork`,
      fields: [
        {
          name: 'creator',
          kind: 'reference',
          path: `${SCHEMA_ORG}creator`,
          output: true,
          ref: { strategy: 'lookup', target: 'Person', local: true },
        },
      ],
    });
    const fields =
      buildCollectionDefinition(work, {
        schema: searchSchema(work, nestedRoot, org),
      }).fields ?? [];

    expect(
      fields.find((field) => field.name === 'creator.affiliation_id'),
    ).toMatchObject({ type: 'string[]', index: true });
  });

  it('declares a facetable-only companion as a list', () => {
    // An identity is earned by `filterable` OR `facetable`, and only a weldable
    // leaf fans out – so a facetable-only companion still harvests every id its
    // entry references, and must be declared as the list the projection writes.
    const org = defineSearchType({
      name: 'Membership',
      fields: [
        {
          name: 'org',
          kind: 'reference',
          path: `${SCHEMA_ORG}memberOf`,
          output: true,
          ref: { strategy: 'lookup', target: 'Person' },
        },
      ],
    });
    const facetedRoot = defineSearchType({
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
        {
          name: 'affiliation',
          kind: 'reference',
          path: `${SCHEMA_ORG}affiliation`,
          output: true,
          facetable: true,
          ref: { strategy: 'inline', typeName: 'Membership', identity: 'org' },
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
          output: true,
          ref: { strategy: 'lookup', target: 'Person', local: true },
        },
      ],
    });
    const fields =
      buildCollectionDefinition(work, {
        schema: searchSchema(work, facetedRoot, org),
      }).fields ?? [];

    expect(
      fields.find((field) => field.name === 'creator.affiliation_id'),
    ).toMatchObject({ type: 'string[]' });
  });

  it('widens an indexed nested leaf of a local lookup’s own root type', () => {
    // `searchSchema` constrains Reference Types, so a weldable leaf there is
    // single-valued – but this same path also declares the fields of the Root
    // Type a `local` lookup nests, where `array` and `filterable` meet on an
    // ordinary facet. Widening must still produce a type.
    const agent = defineSearchType({
      name: 'Agent',
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
        {
          name: 'nationality',
          kind: 'keyword',
          path: `${SCHEMA_ORG}nationality`,
          array: true,
          output: true,
          filterable: true,
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
          ref: { strategy: 'lookup', target: 'Agent', local: true },
        },
      ],
    });
    const fields =
      buildCollectionDefinition(work, {
        schema: searchSchema(work, agent),
      }).fields ?? [];

    expect(
      fields.find((field) => field.name === 'creator.nationality'),
    ).toMatchObject({ type: 'string[]', index: true });
  });

  it('does not double a nested list that is already one', () => {
    // A leaf a weld can name is single-valued (ADR 26), so a nested list is
    // either output-only or searchable. Flattening one under the `object[]`
    // widens it once, not twice – `string[]`, never `string[][]`.
    expect(richField('credit.source')).toMatchObject({
      type: 'string[]',
      index: false,
    });
    expect(richField('credit.attribution_search')).toMatchObject({
      type: 'string[]',
    });
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

  it('queries nested searchable fields too', () => {
    // A companion that is indexed but absent from `query_by` costs the RAM of
    // an indexed field and matches nothing – so the Role has to reach here or
    // it means nothing.
    const params = buildSearchParams({ ...base, text: 'rembrandt' }, work, {
      schema,
    });

    expect(String(params.query_by).split(',')).toContain(
      'creator.creator.label_search_und',
    );
  });

  it('queries the companions of a type that nests ITSELF', () => {
    // The collection declares `related.label_search_und` indexed – one level,
    // then the boundary. A guard that returned on ENTRY stopped a level
    // earlier, so the field was indexed and absent from `query_by`: RAM spent
    // on a field that matches nothing, in silence.
    const selfNesting = defineSearchType({
      name: 'Work',
      class: `${SCHEMA_ORG}CreativeWork`,
      fields: [
        {
          name: 'label',
          kind: 'text',
          path: `${SCHEMA_ORG}name`,
          locales: ['und'],
          output: true,
          searchable: { weight: 1 },
        },
        {
          name: 'related',
          kind: 'reference',
          path: `${SCHEMA_ORG}isRelatedTo`,
          output: true,
          ref: { strategy: 'lookup', target: 'Work', local: true },
        },
      ],
    });
    const selfSchema = searchSchema(selfNesting);
    const declared = (
      buildCollectionDefinition(selfNesting, { schema: selfSchema }).fields ??
      []
    ).filter((field) => field.index !== false);
    const params = buildSearchParams(
      { ...base, text: 'nachtwacht' },
      selfNesting,
      {
        schema: selfSchema,
      },
    );
    const queried = String(params.query_by).split(',');

    expect(queried).toContain('related.label_search_und');
    // The two walks agree: every indexed text companion is queried, and
    // nothing is queried that the collection does not declare.
    expect(
      declared
        .map((field) => field.name)
        .filter((name) => name.endsWith('_search_und')),
    ).toEqual(expect.arrayContaining(queried));
  });

  it('queries every field that nests one edge type, not just the first', () => {
    // Two properties over one edge type is the ordinary case. A guard scoped to
    // the WALK rather than to the path would let `creator` claim the type and
    // leave `contributor`'s companions indexed but never queried.
    const twoEdges = defineSearchType({
      name: 'Work',
      class: `${SCHEMA_ORG}CreativeWork`,
      fields: (['creator', 'contributor'] as const).map((name) => ({
        name,
        kind: 'reference' as const,
        path: `${SCHEMA_ORG}${name}`,
        array: true,
        output: true,
        ref: { strategy: 'inline' as const, typeName: 'CreatorEdge' },
      })),
    });
    const params = buildSearchParams({ ...base, text: 'x' }, twoEdges, {
      schema: searchSchema(twoEdges, person, creatorEdge),
    });
    const queried = String(params.query_by).split(',');

    expect(queried).toContain('creator.creator.label_search_und');
    expect(queried).toContain('contributor.creator.label_search_und');
  });

  it('asks for nothing from a field the collection does not carry', () => {
    // A role-less `local` lookup is an internal reading device: pruned before
    // the writer and declared nowhere. Naming its target's companions in
    // `query_by` makes the engine reject EVERY search on the collection.
    const withReadingDevice = defineSearchType({
      name: 'Work',
      class: `${SCHEMA_ORG}CreativeWork`,
      fields: [
        {
          name: 'title',
          kind: 'text',
          path: `${SCHEMA_ORG}name`,
          locales: ['und'],
          output: true,
          searchable: { weight: 5 },
        },
        {
          name: 'hidden',
          kind: 'reference',
          path: `${SCHEMA_ORG}creator`,
          ref: { strategy: 'lookup', target: 'Person', local: true },
        },
      ],
    });
    const params = buildSearchParams(
      { ...base, text: 'x' },
      withReadingDevice,
      {
        schema: searchSchema(withReadingDevice, person),
      },
    );

    expect(String(params.query_by)).toBe('title_search_und');
  });

  it('stops at a cycle when collecting searchable fields', () => {
    // A `local` lookup can reach a type that reaches back, so the walk that
    // gathers nested search companions has to terminate on its own.
    const cyclicPerson = defineSearchType({
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
        {
          name: 'made',
          kind: 'reference',
          path: `${SCHEMA_ORG}makesOffer`,
          output: true,
          ref: { strategy: 'lookup', target: 'Cyclic', local: true },
        },
      ],
    });
    const cyclicWork = defineSearchType({
      name: 'Cyclic',
      class: `${SCHEMA_ORG}CreativeWork`,
      labelField: 'title',
      fields: [
        {
          name: 'title',
          kind: 'text',
          path: `${SCHEMA_ORG}name`,
          locales: ['und'],
          output: true,
          searchable: { weight: 5 },
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
    const cyclicSchema = searchSchema(cyclicWork, cyclicPerson);

    const params = buildSearchParams({ ...base, text: 'x' }, cyclicWork, {
      schema: cyclicSchema,
    });

    expect(String(params.query_by).split(',')).toEqual([
      'title_search_und',
      'creator.label_search_und',
    ]);
  });

  it('welds conditions into one group, on leaf names only', () => {
    // `path.{a && b}` matches one entry satisfying both, where `path.a && path.b`
    // lets two different entries satisfy them between them.
    //
    // Everything inside the braces is a LEAF name, and must be: Typesense 30.2
    // HANGS on a dotted path inside a group – no error, no result, the
    // connection just times out – so the endpoint's identity is reached through
    // its companion leaf rather than through `creator.id`.
    const params = buildSearchParams(
      {
        ...base,
        where: [
          {
            or: [
              {
                field: 'creator',
                entry: [
                  { field: 'name', in: ['Jan Jansen'] },
                  { field: 'creator', in: ['https://id.example/1'] },
                ],
              },
            ],
          },
        ],
      },
      work,
      { schema },
    );

    expect(params.filter_by).toBe(
      'creator.{name:=[`Jan Jansen`] && creator_id:=[`https://id.example/1`]}',
    );
    // No dotted FIELD PATH inside the braces – checked on the names, since the
    // values are IRIs and full of dots.
    const inside = /\{(.*)\}$/.exec(String(params.filter_by))?.[1] ?? '';
    for (const condition of inside.split(' && ')) {
      expect(condition.slice(0, condition.indexOf(':'))).not.toContain('.');
    }
  });

  it.each([
    [
      'a weld on a field that nests nothing',
      { field: 'role', entry: [{ field: 'x', in: ['y'] }] },
      'id:=[]',
    ],
    [
      'a weld whose condition names no field of the entry',
      { field: 'creator', entry: [{ field: 'nope', in: ['y'] }] },
      'id:=[]',
    ],
    [
      'a weld that states nothing',
      { field: 'creator', entry: [{ field: 'name', in: [] }] },
      undefined,
    ],
  ])('drops %s', (_case, criterion, expected) => {
    // Through the engine `assertValidQuery` rejects the first two; compiled
    // directly, an unusable clause matches nothing and a vacuous one is
    // skipped, exactly as every other clause is.
    const params = buildSearchParams(
      { ...base, where: [{ or: [criterion as never] }] },
      work,
      { schema },
    );

    expect(params.filter_by).toBe(expected);
  });

  it('facets an inline reference on its companion', () => {
    const params = buildSearchParams({ ...base, facets: ['creator'] }, work, {
      schema,
    });

    expect(params.facet_by).toBe('creator_id');
  });
});
