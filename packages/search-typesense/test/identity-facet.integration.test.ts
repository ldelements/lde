import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Client } from 'typesense';
import {
  defineSearchType,
  searchSchema,
  type SearchEngine,
  type SearchQuery,
} from '@lde/search';
import { buildCollectionDefinition } from '../src/collection-definition.js';
import { createTypesenseSearchEngine } from '../src/search.js';
import { TypesenseContainer } from './typesense-container.js';

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

const creatorRole = defineSearchType({
  name: 'CreatorRole',
  fields: [
    {
      name: 'role',
      kind: 'keyword',
      path: `${SCHEMA_ORG}roleName`,
      output: true,
      filterable: true,
    },
    {
      name: 'creator',
      kind: 'reference',
      path: `${SCHEMA_ORG}creator`,
      output: true,
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
      name: 'title',
      kind: 'keyword',
      path: `${SCHEMA_ORG}name`,
      output: true,
      filterable: true,
    },
    {
      name: 'creator',
      kind: 'reference',
      path: `${SCHEMA_ORG}creator`,
      array: true,
      output: true,
      filterable: true,
      facetable: true,
      ref: { strategy: 'inline', typeName: 'CreatorRole', identity: 'creator' },
    },
  ],
});

/**
 * An inline reference’s identity, filtered and faceted on its leaf inside each
 * entry rather than on a flat copy beside the reference (ADR 37). The shape is
 * Linked Open Limburg’s `contributor`: a role edge whose endpoint is a `local`
 * lookup, so the leaf is the id companion beside the endpoint in each entry.
 */
describe('an identity faceted on its nested leaf', () => {
  const container = new TypesenseContainer();
  let engine: SearchEngine;
  const schema = searchSchema(work, person, creatorRole);
  const base: SearchQuery = {
    where: [],
    orderBy: [],
    limit: 10,
    offset: 0,
    facets: ['creator'],
    locale: 'und',
  };
  const counts = (result: { facets: Record<string, unknown> }) =>
    Object.fromEntries(
      (
        result.facets.creator as {
          buckets: { value: string; count: number }[];
        }
      ).buckets.map((bucket) => [bucket.value, bucket.count]),
    );
  const createdBy = (id: string) => ({
    or: [{ field: 'creator', in: [id] }],
  });
  const entry = (role: string, id: string) => ({
    role,
    creator: { id, label_und: id },
    creator_id: id,
  });

  beforeAll(async () => {
    const client: Client = await container.start();
    const definition = buildCollectionDefinition(work, {
      collectionNameFor: () => 'works',
      schema,
    });
    // No flat copy of the ids beside the reference: the nested leaf is what
    // the engine facets.
    expect(definition.fields?.map((field) => field.name)).not.toContain(
      'creator_id',
    );
    await client.collections().create(definition);
    await client.collections().create(
      buildCollectionDefinition(person, {
        collectionNameFor: () => 'people',
        schema,
      }),
    );
    const results = await client
      .collections('works')
      .documents()
      .import(
        [
          {
            // One person in two roles, and a second person.
            id: 'https://ex/etching',
            title: 'etching',
            creator: [
              entry('etser', 'https://ex/anna'),
              entry('drukker', 'https://ex/anna'),
              entry('drukker', 'https://ex/bram'),
            ],
          },
          {
            id: 'https://ex/print',
            title: 'print',
            creator: [entry('drukker', 'https://ex/bram')],
          },
          { id: 'https://ex/anonymous', title: 'anonymous' },
        ],
        { action: 'create' },
      );
    expect(results.every((result) => result.success)).toBe(true);
    engine = createTypesenseSearchEngine(client, schema, {
      collections: { Work: 'works', Person: 'people' },
    });
  }, 120_000);

  afterAll(async () => {
    await container.stop();
  });

  it('counts a work once per person, however many roles name them', async () => {
    const result = await engine.search(work, base);

    expect(counts(result)).toEqual({
      'https://ex/anna': 1,
      'https://ex/bram': 2,
    });
  });

  it('filters the works by the person, and counts without its own selection', async () => {
    const result = await engine.search(work, {
      ...base,
      where: [createdBy('https://ex/anna')],
    });

    expect(result.hits.map((hit) => hit.id)).toEqual(['https://ex/etching']);
    expect(counts(result)).toEqual({
      'https://ex/anna': 1,
      'https://ex/bram': 2,
    });
  });

  it('counts under a condition on one entry', async () => {
    const result = await engine.search(work, {
      ...base,
      where: [
        {
          or: [
            {
              field: 'creator',
              entry: [
                { field: 'role', in: ['etser'] },
                { field: 'creator', in: ['https://ex/anna'] },
              ],
            },
          ],
        },
      ],
    });

    // A weld of two conditions is nobody’s own (ADR 36), so the facet counts
    // under it: only the etching, whose other entries still count.
    expect(result.hits.map((hit) => hit.id)).toEqual(['https://ex/etching']);
    expect(counts(result)).toEqual({
      'https://ex/anna': 1,
      'https://ex/bram': 1,
    });
  });
});
