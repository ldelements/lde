import { describe, expect, it } from 'vitest';
import { missingRequiredFields, projectDocument } from '../src/project.js';
import { defineSearchType, searchSchema } from '../src/schema.js';

const SCHEMA_ORG = 'https://schema.org/';
const workKey = (field: string) => `urn:lde:Work/${field}`;
const edgeKey = (field: string) => `urn:lde:CreatorEdge/${field}`;

const creatorEdge = defineSearchType({
  name: 'CreatorEdge',
  fields: [
    {
      name: 'role',
      kind: 'keyword',
      path: `${SCHEMA_ORG}roleName`,
      output: true,
      required: true,
    },
  ],
});

const work = defineSearchType({
  name: 'Work',
  class: `${SCHEMA_ORG}CreativeWork`,
  fields: [
    {
      name: 'name',
      kind: 'text',
      path: `${SCHEMA_ORG}name`,
      locales: ['nl', 'en'],
      output: true,
      searchable: { weight: 1 },
      required: true,
    },
    {
      name: 'datePublished',
      kind: 'date',
      path: `${SCHEMA_ORG}datePublished`,
      output: true,
      required: true,
    },
    {
      name: 'keywords',
      kind: 'keyword',
      path: `${SCHEMA_ORG}keywords`,
      array: true,
      output: true,
      required: true,
    },
    {
      name: 'creator',
      kind: 'reference',
      path: `${SCHEMA_ORG}creator`,
      array: true,
      output: true,
      ref: { strategy: 'inline', typeName: 'CreatorEdge' },
    },
    {
      name: 'mainCreator',
      kind: 'reference',
      path: `${SCHEMA_ORG}author`,
      output: true,
      ref: { strategy: 'inline', typeName: 'CreatorEdge' },
    },
  ],
});

const schema = searchSchema(work, creatorEdge);

const project = (node: Record<string, unknown>) =>
  projectDocument(
    { '@id': 'https://ex/work/1', ...node },
    schema.get(work.class)!,
    schema,
  );

describe('missingRequiredFields', () => {
  it('finds nothing missing in a document that has every required field', () => {
    const document = project({
      [workKey('name')]: { '@language': 'en', '@value': 'Title' },
      [workKey('datePublished')]: { '@value': '2026-01-01' },
    });

    expect(missingRequiredFields(document, work, schema)).toEqual([]);
  });

  it('counts a text field present in any one language', () => {
    const document = project({
      [workKey('name')]: { '@language': 'fr', '@value': 'Titre' },
      [workKey('datePublished')]: { '@value': '2026-01-01' },
    });

    expect(missingRequiredFields(document, work, schema)).toEqual([]);
  });

  it('names every required field a document lacks', () => {
    const document = project({
      [workKey('keywords')]: [{ '@value': 'literatuur' }],
    });

    expect(missingRequiredFields(document, work, schema)).toEqual([
      'name',
      'datePublished',
    ]);
  });

  it('never reports an array field, which the API serves as empty', () => {
    const document = project({
      [workKey('name')]: { '@language': 'nl', '@value': 'Titel' },
      [workKey('datePublished')]: { '@value': '2026-01-01' },
    });

    expect(document.keywords).toBeUndefined();
    expect(missingRequiredFields(document, work, schema)).toEqual([]);
  });

  it('reads a text field from its search companion, and passes booleans and internal fields', () => {
    const note = defineSearchType({
      name: 'Note',
      class: `${SCHEMA_ORG}Comment`,
      fields: [
        {
          name: 'text',
          kind: 'text',
          path: `${SCHEMA_ORG}text`,
          locales: ['nl'],
          searchable: { weight: 1 },
          required: true,
        },
        {
          name: 'draft',
          kind: 'boolean',
          path: `${SCHEMA_ORG}creativeWorkStatus`,
          output: true,
          required: true,
        },
        // No role, so pruned before any writer sees it.
        {
          name: 'helper',
          kind: 'keyword',
          path: `${SCHEMA_ORG}about`,
          required: true,
        },
      ],
    });

    expect(missingRequiredFields({ text_search_nl: 'notitie' }, note)).toEqual(
      [],
    );
    expect(missingRequiredFields({}, note)).toEqual(['text']);
  });

  it('holds every referent of an inline reference to its own required fields', () => {
    const document = project({
      [workKey('name')]: { '@language': 'nl', '@value': 'Titel' },
      [workKey('datePublished')]: { '@value': '2026-01-01' },
      [workKey('creator')]: [
        {
          '@id': 'https://ex/edge/1',
          [edgeKey('role')]: { '@value': 'author' },
        },
        {
          '@id': 'https://ex/edge/2',
          [edgeKey('role')]: { '@value': 'illustrator' },
        },
      ],
    });
    // A referent that lost its role (e.g. to a reader transform) after framing.
    (document.creator as Record<string, unknown>[]).push({});

    expect(missingRequiredFields(document, work, schema)).toEqual([
      'creator.role',
    ]);
  });

  it('does not mistake a sibling field for a language of a text field', () => {
    const note = defineSearchType({
      name: 'Note',
      class: `${SCHEMA_ORG}Comment`,
      fields: [
        {
          name: 'title',
          kind: 'text',
          path: `${SCHEMA_ORG}name`,
          locales: ['nl'],
          output: true,
          required: true,
        },
        {
          name: 'title_short',
          kind: 'keyword',
          path: `${SCHEMA_ORG}alternateName`,
          output: true,
        },
      ],
    });

    expect(missingRequiredFields({ title_short: 'Kort' }, note)).toEqual([
      'title',
    ]);
  });

  it('holds a single referent to its required fields too', () => {
    expect(
      missingRequiredFields(
        { id: 'urn:x', name_nl: 'Titel', datePublished: 0, mainCreator: {} },
        work,
        schema,
      ),
    ).toEqual(['mainCreator.role']);
  });
});
