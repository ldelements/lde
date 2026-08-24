import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Parser } from 'n3';
import type { Client } from 'typesense';
import {
  defineSearchType,
  projectRoots,
  searchSchema,
  type RootType,
  type SearchDocument,
  type SearchEngine,
  type SearchQuery,
} from '@lde/search';
import { describeSearchEngineContract } from '@lde/search/testing';
import { buildCollectionDefinition } from '../src/collection-definition.js';
import { InPlaceRebuild } from '../src/in-place-rebuild.js';
import { buildSearchParams } from '../src/query-compiler.js';
import { createTypesenseSearchEngine } from '../src/search.js';
import { fakeTypesenseClient, labelLookup } from './fake-typesense-client.js';
import { makeRunContext } from './helpers.js';
import { TypesenseContainer } from './typesense-container.js';

// A facet policy (`RootType.facetKeys`) declared once on `Place` and inherited
// by every facetable reference that names it: the engine facets a
// `${name}_facet` companion holding the admitted keys, the field itself stays
// whole, and a filter on it stays exact.

const SCHEMA_ORG = 'https://schema.org/';
const GEONAMES = 'https://sws.geonames.org/';
const VENLO = `${GEONAMES}2745706`;
/** The deployment’s one predicate, built into `pick` and the policy alike. */
const isCovered = (iri: string) => iri.startsWith(GEONAMES);

const place = defineSearchType({
  name: 'Place',
  class: `${SCHEMA_ORG}Place`,
  labelField: 'name',
  key: { field: '_sameAs', pick: (candidates) => candidates.find(isCovered) },
  facetKeys: { only: isCovered },
  fields: [
    {
      name: 'name',
      kind: 'text',
      path: `<${SCHEMA_ORG}name>`,
      locales: ['und'],
      output: true,
      searchable: { weight: 1 },
    },
    {
      name: '_sameAs',
      kind: 'reference',
      array: true,
      path: `<${SCHEMA_ORG}sameAs>`,
    },
  ],
});

const work = defineSearchType({
  name: 'CreativeWork',
  class: `${SCHEMA_ORG}CreativeWork`,
  fields: [
    {
      name: 'title',
      kind: 'text',
      path: `<${SCHEMA_ORG}name>`,
      locales: ['und'],
      output: true,
      searchable: { weight: 1 },
    },
    {
      name: 'locationCreated',
      kind: 'reference',
      path: `<${SCHEMA_ORG}locationCreated>`,
      facetable: true,
      filterable: true,
      output: true,
      ref: { strategy: 'lookup', target: 'Place' },
    },
    {
      name: 'about',
      kind: 'reference',
      array: true,
      path: `<${SCHEMA_ORG}about>`,
      facetable: true,
      filterable: true,
      output: true,
      ref: { strategy: 'idOnly' },
      labelSource: 'Place',
    },
    {
      // Facetable, but names no type: inherits no policy.
      name: 'genre',
      kind: 'keyword',
      path: `<${SCHEMA_ORG}genre>`,
      facetable: true,
      filterable: true,
    },
  ],
});

const schema = searchSchema(place, work);

const baseQuery: SearchQuery = {
  where: [],
  orderBy: [],
  limit: 10,
  offset: 0,
  facets: [],
  locale: 'und',
};

describe('collection definition', () => {
  const definition = buildCollectionDefinition(work, { schema });

  it('facets the `_facet` companion of a reference inheriting a policy, not the field', () => {
    expect(definition.fields).toContainEqual({
      name: 'locationCreated',
      type: 'string',
      facet: false,
      sort: false,
      optional: true,
    });
    expect(definition.fields).toContainEqual({
      name: 'locationCreated_facet',
      type: 'string',
      facet: true,
      optional: true,
    });
    expect(definition.fields).toContainEqual({
      name: 'about',
      type: 'string[]',
      facet: false,
      sort: false,
      optional: true,
    });
    expect(definition.fields).toContainEqual({
      name: 'about_facet',
      type: 'string[]',
      facet: true,
      optional: true,
    });
    // A facet inheriting no policy is declared as before.
    expect(definition.fields).toContainEqual({
      name: 'genre',
      type: 'string',
      facet: true,
      sort: false,
      optional: true,
    });
  });

  it('facets the field itself when built without the schema, as the projection reads it', () => {
    // No schema, no visible policy – the same degraded reading the projection
    // makes when it cannot re-key a reference. Whether a policy applies cannot
    // be told here, so a schema-less build is not refused.
    const schemaless = buildCollectionDefinition(work);

    expect(schemaless.fields).toContainEqual(
      expect.objectContaining({ name: 'locationCreated', facet: true }),
    );
    expect(schemaless.fields?.map((field) => field.name)).not.toContain(
      'locationCreated_facet',
    );
  });
});

describe('query compiler', () => {
  it('facets the companion, and filters the field itself exactly', () => {
    const params = buildSearchParams(
      {
        ...baseQuery,
        facets: ['locationCreated', 'about', 'genre'],
        where: [
          { or: [{ field: 'locationCreated', in: ['https://a/place/2'] }] },
          { or: [{ field: 'genre', in: ['map'] }] },
        ],
      },
      work,
      { schema },
    );

    expect(params.facet_by).toBe('locationCreated_facet,about_facet,genre');
    // The field is `facetable` in the schema but not a facet in the engine, so
    // the tokenized `:` operator – which would partial-match an IRI on a
    // shared path prefix – is wrong for it; a plain facet keeps `:`.
    expect(params.filter_by).toBe(
      'locationCreated:=[`https://a/place/2`] && genre:[`map`]',
    );
  });
});

describe('response boundary', () => {
  const facetCounts = [
    {
      // The engine reports the facet under the field it faceted.
      field_name: 'locationCreated_facet',
      counts: [{ value: VENLO, count: 2 }],
    },
    { field_name: 'genre', counts: [{ value: 'map', count: 1 }] },
  ];
  const labels = labelLookup({ [VENLO]: { name_und: 'Venlo' } });

  it('files a policy facet under the declared field, with its labels', async () => {
    const fake = fakeTypesenseClient({
      searchResponse: { found: 0, hits: [], facet_counts: facetCounts },
      multiSearch: labels,
    });
    const engine = createTypesenseSearchEngine(fake.client, schema);

    const result = await engine.search(work, {
      ...baseQuery,
      facets: ['locationCreated', 'genre'],
    });

    expect(result.facets).toEqual({
      locationCreated: [{ value: VENLO, count: 2, label: { und: ['Venlo'] } }],
      genre: [{ value: 'map', count: 1 }],
    });
  });

  it('maps every response of a facet batch the same way', async () => {
    const fake = fakeTypesenseClient({
      searchResponse: { found: 0, hits: [], facet_counts: facetCounts },
      multiSearch: labels,
    });
    const engine = createTypesenseSearchEngine(fake.client, schema);

    const [outcome] = await engine.searchFacets(work, [
      { ...baseQuery, facets: ['locationCreated'] },
    ]);

    expect(outcome).toEqual({
      facets: {
        locationCreated: [
          { value: VENLO, count: 2, label: { und: ['Venlo'] } },
        ],
        genre: [{ value: 'map', count: 1 }],
      },
    });
  });
});

describe('facet policy end to end (integration)', () => {
  const container = new TypesenseContainer();
  let client: Client;
  let engine: SearchEngine;

  // The extraction’s output, as the pipeline hands it to the projection: each
  // value under its field’s IR Alias, and – for a reference into the keyed
  // Place – the referent’s key candidates one hop further, read by the
  // referring type’s query. An aligned place, publisher A’s Kessel, a second
  // place under it sharing its IRI as a path prefix, and publisher B’s own,
  // unaligned Kessel.
  const VENLO_NODE = 'https://a/place/1';
  const KESSEL = 'https://a/place/2';
  const KESSEL_CENTRUM = 'https://a/place/2/centrum';
  const OTHER_KESSEL = 'https://b/place/7';
  const placeQuads = `
    <${VENLO_NODE}> <urn:lde:Place/name> "Venlo" .
    <${VENLO_NODE}> <urn:lde:Place/_sameAs> <${VENLO}> .
    <${KESSEL}> <urn:lde:Place/name> "Kessel" .
    <${KESSEL_CENTRUM}> <urn:lde:Place/name> "Kessel-Centrum" .
    <${OTHER_KESSEL}> <urn:lde:Place/name> "Kessel" .
  `;
  const workQuads = `
    <https://a/work/1> <urn:lde:CreativeWork/title> "Map of Venlo" .
    <https://a/work/1> <urn:lde:CreativeWork/locationCreated> <${VENLO_NODE}> .
    <https://a/work/1> <urn:lde:CreativeWork/about> <${VENLO_NODE}> .
    <https://a/work/1> <urn:lde:CreativeWork/about> <${KESSEL}> .
    <https://a/work/2> <urn:lde:CreativeWork/title> "Kessel church" .
    <https://a/work/2> <urn:lde:CreativeWork/locationCreated> <${KESSEL}> .
    <https://a/work/3> <urn:lde:CreativeWork/title> "Kessel square" .
    <https://a/work/3> <urn:lde:CreativeWork/locationCreated> <${KESSEL_CENTRUM}> .
    <https://a/work/3> <urn:lde:CreativeWork/about> <${VENLO_NODE}> .
    <https://b/work/4> <urn:lde:CreativeWork/title> "The other Kessel" .
    <https://b/work/4> <urn:lde:CreativeWork/locationCreated> <${OTHER_KESSEL}> .
    <${VENLO_NODE}> <urn:lde:Place/_sameAs> <${VENLO}> .
  `;

  async function project(
    nTriples: string,
    roots: readonly string[],
    searchType: RootType,
  ): Promise<SearchDocument[]> {
    const quads = new Parser({ format: 'N-Triples' }).parse(nTriples);
    const documents: SearchDocument[] = [];
    for await (const document of projectRoots(
      quads,
      roots,
      schema,
      searchType,
    )) {
      documents.push(document);
    }
    return documents;
  }

  beforeAll(async () => {
    client = await container.start();
    await client
      .collections()
      .create(buildCollectionDefinition(place, { schema }));
    await client
      .collections()
      .create(buildCollectionDefinition(work, { schema }));
    await client
      .collections('places')
      .documents()
      .import(
        await project(
          placeQuads,
          [VENLO_NODE, KESSEL, KESSEL_CENTRUM, OTHER_KESSEL],
          place,
        ),
        { action: 'create' },
      );
    await client
      .collections('creative_works')
      .documents()
      .import(
        await project(
          workQuads,
          [
            'https://a/work/1',
            'https://a/work/2',
            'https://a/work/3',
            'https://b/work/4',
          ],
          work,
        ),
        { action: 'create' },
      );
    engine = createTypesenseSearchEngine(client, schema);
  }, 120_000);

  afterAll(async () => {
    await container.stop();
  });

  describeSearchEngineContract(
    'TypesenseSearchEngine with a facet policy',
    () => engine,
  );

  it('buckets every facet referencing Place on the admitted key only, labelled', async () => {
    const result = await engine.search(work, {
      ...baseQuery,
      facets: ['locationCreated', 'about'],
    });

    expect(result.total).toBe(4);
    // Three local Kessels – two of them one place by name – and not one bucket
    // among them; the aligned place is the facet, labelled from its document.
    expect(result.facets.locationCreated).toEqual([
      { value: VENLO, count: 1, label: { und: ['Venlo'] } },
    ]);
    expect(result.facets.about).toEqual([
      { value: VENLO, count: 2, label: { und: ['Venlo'] } },
    ]);
  });

  it('keeps the field whole: a local place still displays and still filters exactly', async () => {
    const result = await engine.search(work, {
      ...baseQuery,
      where: [{ or: [{ field: 'locationCreated', in: [KESSEL] }] }],
    });

    // Kessel, not Kessel-Centrum, whose IRI extends Kessel’s by a path segment.
    expect(result.total).toBe(1);
    expect(result.hits.map((hit) => hit.id)).toEqual(['https://a/work/2']);
    expect(result.hits[0].document.locationCreated).toEqual({
      id: KESSEL,
      label: { und: ['Kessel'] },
    });
  });

  it('fails an in-place run at open over a collection that predates the policy', async () => {
    // What a deployment that adds `facetKeys` to a type meets under in-place
    // rebuild: the collections referencing that type were created without the
    // companion, and the documents are about to carry it. Loud, at run open,
    // naming the drop that fixes it – never a silently broken facet.
    const prePolicy = buildCollectionDefinition(work, { schema });
    await client.collections().create({
      ...prePolicy,
      name: 'pre_policy_works',
      fields: (prePolicy.fields ?? [])
        .filter((field) => !field.name.endsWith('_facet'))
        .map((field) =>
          field.name === 'locationCreated' || field.name === 'about'
            ? { ...field, facet: true }
            : field,
        ),
    });
    const writer = new InPlaceRebuild(client, work, {
      schema,
      collectionNameFor: () => 'pre_policy_works',
    });

    await expect(writer.openRun(makeRunContext())).rejects.toThrow(
      /exists without the facet field\(s\) “locationCreated_facet”, “about_facet”.*drop “pre_policy_works”/s,
    );
  });

  it('creates an in-place collection with the companions, and reopens it', async () => {
    const writer = new InPlaceRebuild(client, work, {
      schema,
      collectionNameFor: () => 'fresh_works',
    });

    const run = await writer.openRun(makeRunContext());
    await run.abort(new Error('done'));
    const created = await client.collections('fresh_works').retrieve();
    expect(created.fields.map((field) => field.name)).toContain(
      'locationCreated_facet',
    );
    // The companion is there, so the next run opens.
    const reopened = await writer.openRun(makeRunContext());
    await reopened.abort(new Error('done'));
  });
});
