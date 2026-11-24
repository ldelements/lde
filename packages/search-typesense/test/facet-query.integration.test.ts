import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Client } from 'typesense';
import {
  defineSearchType,
  searchSchema,
  type Facet,
  type FacetsOutcome,
  type SearchQuery,
  type SearchType,
  type TextField,
} from '@lde/search';
import { labelMatchValue, physicalFields } from '@lde/search/adapter';
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
      searchable: { weight: 2 },
    },
    {
      // Searched, never shown: an alternate name only the people collection
      // holds, as enrichment supplies it.
      name: 'alternateName',
      kind: 'text',
      path: `${SCHEMA_ORG}alternateName`,
      locales: ['und'],
      searchable: { weight: 1 },
    },
  ],
});

const organization = defineSearchType({
  name: 'Organization',
  class: `${SCHEMA_ORG}Organization`,
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

const work = defineSearchType({
  name: 'Work',
  class: `${SCHEMA_ORG}CreativeWork`,
  fields: [
    {
      name: 'keyword',
      kind: 'keyword',
      path: `${SCHEMA_ORG}keywords`,
      array: true,
      output: true,
      filterable: true,
      facetable: true,
    },
    {
      name: 'creator',
      kind: 'reference',
      path: `${SCHEMA_ORG}creator`,
      array: true,
      output: true,
      filterable: true,
      facetable: true,
      ref: { strategy: 'idOnly' },
      labelSource: ['Person', 'Organization'],
    },
    {
      // Derived, so its documents store no labels: a query searches the
      // people collection instead.
      name: 'subjectOf',
      kind: 'reference',
      array: true,
      output: true,
      filterable: true,
      facetable: true,
      ref: { strategy: 'idOnly' },
      labelSource: 'Person',
      derive: () => [],
    },
    {
      name: 'genre',
      kind: 'reference',
      path: `${SCHEMA_ORG}genre`,
      array: true,
      output: true,
      filterable: true,
      facetable: true,
      ref: { strategy: 'idOnly' },
    },
  ],
});

const rembrandt = 'https://ex/rembrandt';
const rembert = 'https://ex/rembert';
const harmen = 'https://ex/harmen';
const remonstrants = 'https://ex/remonstrants';
// Another referent its documents call “Rembrandt van Rijn” too.
const namesake = 'https://ex/rembrandt-namesake';
const timor = 'https://ex/timor';
// Twenty people who share every work Rembert made, and have made more.
const others = Array.from({ length: 20 }, (_, index) => `https://ex/p${index}`);

/** The label each work’s graph states for a creator, as the projection
 *  copies it into the label-match companion. */
const labels: Readonly<Record<string, string>> = {
  [rembrandt]: 'Rembrandt van Rijn',
  [rembert]: 'Rembert Dodoens',
  [harmen]: 'Harmen Gerritsz',
  [remonstrants]: 'Remonstrantse Broederschap',
  [namesake]: 'Rembrandt van Rijn',
  [timor]: 'Timor (Petrus Regout/Sphinx)',
  ...Object.fromEntries(
    others.map((id, index) => [id, `Painter ${index}`] as const),
  ),
};

/** A work document with the label-match companion its creators’ labels give. */
const workDocument = (id: string, keyword: string[], creator: string[]) => ({
  id,
  keyword,
  creator,
  creator_match: creator.map(
    (iri) => labelMatchValue([labels[iri] as string], iri) as string,
  ),
});

/**
 * A facet’s values searched by text (`facetQueries`), end to end through a
 * real Typesense: a literal facet through `facet_query`, a reference facet in
 * two steps – the referents whose labels on the documents match the text,
 * through `facet_query` on the label-match companion, then each counted over
 * the facet field.
 */
describe('a facet query', () => {
  const container = new TypesenseContainer();
  let client: Client;
  const schema = searchSchema(work, person, organization);
  const collections = {
    Work: 'works',
    Person: 'people',
    Organization: 'organizations',
  };
  let engine: ReturnType<typeof createTypesenseSearchEngine>;
  const base: SearchQuery = {
    where: [],
    orderBy: [],
    limit: 0,
    offset: 0,
    facets: [],
    locale: 'und',
  };
  const facetOf = (outcome: FacetsOutcome | undefined, name: string): Facet => {
    if (outcome === undefined || 'error' in outcome) {
      throw new Error(`Expected facets, got ${String(outcome)}`);
    }
    return outcome.facets[name] as Facet;
  };
  const counts = (facet: Facet) =>
    facet.buckets.map((bucket) => [bucket.value, bucket.count]);
  const searchName = (type: SearchType, name: string) =>
    physicalFields(
      type.fields.find((field) => field.name === name) as TextField,
    ).search[0] as string;
  const named = (
    type: typeof person | typeof organization,
    id: string,
    label: string,
    alternateName?: string,
  ) => ({
    id,
    label_und: label,
    [searchName(type, 'label')]: label.toLowerCase(),
    ...(alternateName !== undefined
      ? { [searchName(person, 'alternateName')]: alternateName.toLowerCase() }
      : {}),
  });

  beforeAll(async () => {
    client = await container.start();
    for (const [type, name] of [
      [work, 'works'],
      [person, 'people'],
      [organization, 'organizations'],
    ] as const) {
      await client.collections().create(
        buildCollectionDefinition(type, {
          collectionNameFor: () => name,
          schema,
        }),
      );
    }
    const imports = [
      await client
        .collections('people')
        .documents()
        .import(
          [
            named(person, rembrandt, 'Rembrandt van Rijn'),
            named(person, rembert, 'Rembert Dodoens'),
            // Called “Remmert” only in the people collection, as enrichment
            // supplies it: no work carries the name, so no query finds it.
            named(person, harmen, 'Harmen Gerritsz', 'Remmert'),
            named(person, namesake, 'Rembrandt van Rijn'),
            ...others.map((id, index) => named(person, id, `Painter ${index}`)),
          ],
          { action: 'create' },
        ),
      await client
        .collections('organizations')
        .documents()
        .import(
          [
            named(organization, remonstrants, 'Remonstrantse Broederschap'),
            named(organization, timor, 'Timor (Petrus Regout/Sphinx)'),
          ],
          {
            action: 'create',
          },
        ),
      await client
        .collections('works')
        .documents()
        .import(
          [
            ...[1, 2, 3].map((index) => ({
              ...workDocument(
                `https://ex/painting-${index}`,
                ['schilderij'],
                [rembrandt],
              ),
              genre: ['https://ex/portrait'],
            })),
            // Rembrandt under another label, and stated by IRI alone: still
            // his works, which his bucket counts.
            {
              id: 'https://ex/etching-1',
              keyword: ['ets'],
              creator: [rembrandt],
              creator_match: [
                labelMatchValue(['Rembrandt Harmenszoon'], rembrandt),
              ],
            },
            {
              id: 'https://ex/etching-2',
              keyword: ['ets'],
              creator: [rembrandt],
            },
            workDocument('https://ex/etching-3', ['ets'], [namesake]),
            ...[1, 2].map((index) =>
              workDocument(
                `https://ex/herbal-${index}`,
                index === 1
                  ? ['boek', 'kruid', 'kruidenboek']
                  : ['boek', 'kruid'],
                [rembert, ...others],
              ),
            ),
            ...[1, 2, 3].map((index) =>
              workDocument(`https://ex/other-${index}`, ['boek'], others),
            ),
            workDocument('https://ex/pamphlet', ['pamflet'], [remonstrants]),
            {
              ...workDocument(
                'https://ex/drawing',
                ['schilderij'],
                [harmen, ...others],
              ),
              subjectOf: [harmen],
            },
            workDocument('https://ex/plate', ['servies'], [timor]),
          ],
          { action: 'create' },
        ),
    ];
    expect(imports.flat().every((result) => result.success)).toBe(true);
    engine = createTypesenseSearchEngine(client, schema, { collections });
  }, 120_000);

  afterAll(async () => {
    await container.stop();
  });

  it('returns only the literal values matching it, by count, capped at the limit', async () => {
    const [outcome] = await engine.searchFacets(work, [
      {
        ...base,
        facets: ['keyword'],
        facetQueries: { keyword: 'krui' },
        facetLimits: { keyword: 1 },
      },
    ]);
    const facet = facetOf(outcome, 'keyword');

    expect(counts(facet)).toEqual([['kruid', 2]]);
    // `stats.total_values` counts the values matching the query, not all.
    expect(facet.totalValues).toBe(2);
  });

  it('finds a referent by the label its documents carry, in every target type', async () => {
    const [outcome] = await engine.searchFacets(work, [
      { ...base, facets: ['creator'], facetQueries: { creator: 'rem' } },
    ]);
    const facet = facetOf(outcome, 'creator');

    expect(counts(facet)).toEqual([
      [rembrandt, 5],
      [rembert, 2],
      // Equal counts come in the engine’s order.
      ...counts(facet).slice(2),
    ]);
    // Not Harmen: “Remmert” is a name only the people collection holds.
    expect(
      new Set(
        counts(facet)
          .slice(2)
          .map(([value]) => value),
      ),
    ).toEqual(new Set([remonstrants, namesake]));
    expect(facet.totalValues).toBe(4);
    expect(facet.buckets[0]?.label).toEqual({ und: ['Rembrandt van Rijn'] });
  });

  it('counts every work carrying a matched referent, whichever label it carries, or none', async () => {
    const [outcome] = await engine.searchFacets(work, [
      {
        ...base,
        facets: ['creator'],
        facetQueries: { creator: 'harmenszoon' },
      },
    ]);
    const facet = facetOf(outcome, 'creator');

    // One work carries the label that matched; Rembrandt is on five, and the
    // facet without a query says so too.
    expect(counts(facet)).toEqual([[rembrandt, 5]]);
    expect(facet.totalValues).toBe(1);
  });

  it('keeps two referents sharing a label apart', async () => {
    const [outcome] = await engine.searchFacets(work, [
      { ...base, facets: ['creator'], facetQueries: { creator: 'rijn' } },
    ]);

    expect(counts(facetOf(outcome, 'creator'))).toEqual([
      [rembrandt, 5],
      [namesake, 1],
    ]);
  });

  it('matches a word its label’s punctuation joins, and never the id', async () => {
    const [sphinx, scheme, segment, nearGuard] = await engine.searchFacets(
      work,
      [
        { ...base, facets: ['creator'], facetQueries: { creator: 'sphinx' } },
        { ...base, facets: ['creator'], facetQueries: { creator: 'https' } },
        { ...base, facets: ['creator'], facetQueries: { creator: 'namesake' } },
        // A word, as a person types one: no typo brings it to the guard the
        // id starts with.
        { ...base, facets: ['creator'], facetQueries: { creator: 'olde' } },
      ],
    );

    expect(counts(facetOf(sphinx, 'creator'))).toEqual([[timor, 1]]);
    expect(counts(facetOf(scheme, 'creator'))).toEqual([]);
    expect(counts(facetOf(segment, 'creator'))).toEqual([]);
    expect(counts(facetOf(nearGuard, 'creator'))).toEqual([]);
  });

  it('matches a label typed as it shows, punctuation included', async () => {
    const [typed, punctuation] = await engine.searchFacets(work, [
      {
        ...base,
        facets: ['creator'],
        facetQueries: { creator: 'Regout/Sphinx' },
      },
      { ...base, facets: ['creator'], facetQueries: { creator: '(-)' } },
    ]);

    expect(counts(facetOf(typed, 'creator'))).toEqual([[timor, 1]]);
    // No word to match, so no label matches.
    expect(facetOf(punctuation, 'creator')).toEqual({
      buckets: [],
      totalValues: 0,
    });
  });

  it('searches the referenced collection for a facet whose documents store no labels', async () => {
    const [outcome] = await engine.searchFacets(work, [
      {
        ...base,
        facets: ['subjectOf'],
        facetQueries: { subjectOf: 'remmert' },
      },
    ]);
    const facet = facetOf(outcome, 'subjectOf');

    // Found by the alternate name only the people collection holds.
    expect(counts(facet)).toEqual([[harmen, 1]]);
    expect(facet.totalValues).toBe(1);
  });

  it('forgives no typo in a word shorter than four characters', async () => {
    const [reference, literal] = await engine.searchFacets(work, [
      // One typo from “rem”, which starts Rembrandt, Rembert and Remonstrantse.
      { ...base, facets: ['creator'], facetQueries: { creator: 'rex' } },
      // One typo from “boek”.
      { ...base, facets: ['keyword'], facetQueries: { keyword: 'bok' } },
    ]);

    expect(counts(facetOf(reference, 'creator'))).toEqual([]);
    expect(counts(facetOf(literal, 'keyword'))).toEqual([]);
  });

  it('answers a query over documents no filter leaves with an empty facet', async () => {
    const [outcome] = await engine.searchFacets(work, [
      {
        ...base,
        where: [{ or: [{ field: 'keyword', in: ['nergens'] }] }],
        facets: ['creator'],
        facetQueries: { creator: 'rem' },
      },
    ]);

    expect(facetOf(outcome, 'creator')).toEqual({
      buckets: [],
      totalValues: 0,
    });
  });

  it('keeps a match that co-occurs with many values that outnumber it', async () => {
    // Rembert’s two works and Harmen’s drawing carry twenty other people, so
    // over the works carrying a match each of them counts 3: more than Rembert
    // and Harmen. They must not crowd either out of the buckets.
    const [outcome] = await engine.searchFacets(work, [
      {
        ...base,
        facets: ['creator'],
        facetQueries: { creator: 'rem' },
        facetLimits: { creator: 2 },
      },
    ]);
    const facet = facetOf(outcome, 'creator');

    expect(counts(facet)).toEqual([
      [rembrandt, 5],
      [rembert, 2],
    ]);
    expect(facet.totalValues).toBe(4);
  });

  it('counts under the other filters, without its own', async () => {
    const [outcome] = await engine.searchFacets(work, [
      {
        ...base,
        where: [
          { or: [{ field: 'keyword', in: ['boek'] }] },
          { or: [{ field: 'creator', in: [others[0] as string] }] },
        ],
        facets: ['creator'],
        facetQueries: { creator: 'rem' },
      },
    ]);
    const facet = facetOf(outcome, 'creator');

    // Only books: Rembert’s herbals. The selected Painter 0 does not match
    // “rem”, so it does not come back.
    expect(counts(facet)).toEqual([[rembert, 2]]);
    expect(facet.totalValues).toBe(1);
  });

  it('leaves out a selected value that does not match, which the facet without a query keeps', async () => {
    const selected: SearchQuery = {
      ...base,
      where: [
        { or: [{ field: 'keyword', in: ['pamflet'] }] },
        { or: [{ field: 'creator', in: [others[0] as string] }] },
      ],
      facets: ['keyword', 'creator'],
    };
    const [queried, unqueried] = await engine.searchFacets(work, [
      {
        ...selected,
        facetQueries: { keyword: 'kruidenboek', creator: 'rembrandt' },
      },
      selected,
    ]);

    // No work is a pamphlet by Painter 0. Without a query both selections
    // come back at 0, to undo them; under one only matching values do.
    expect(counts(facetOf(queried, 'keyword'))).toEqual([['kruidenboek', 1]]);
    expect(counts(facetOf(queried, 'creator'))).toEqual([]);
    expect(counts(facetOf(unqueried, 'keyword'))).toContainEqual([
      'pamflet',
      0,
    ]);
    expect(counts(facetOf(unqueried, 'creator'))).toContainEqual([
      others[0],
      0,
    ]);
  });

  it('reports no total when the referent search filled its cap', async () => {
    const capped = createTypesenseSearchEngine(client, schema, {
      collections,
      maxFacetQueryCandidates: 1,
    });
    const [outcome] = await capped.searchFacets(work, [
      { ...base, facets: ['creator'], facetQueries: { creator: 'rem' } },
    ]);
    const facet = facetOf(outcome, 'creator');

    // The one most frequent match, and no telling how many more there are.
    expect(counts(facet)).toEqual([[rembrandt, 5]]);
    expect(facet.totalValues).toBeUndefined();
  });

  it('answers a query no referent matches with an empty facet', async () => {
    const [outcome] = await engine.searchFacets(work, [
      { ...base, facets: ['creator'], facetQueries: { creator: 'xqzzv' } },
    ]);

    expect(facetOf(outcome, 'creator')).toEqual({
      buckets: [],
      totalValues: 0,
    });
  });

  it('leaves the hits of a search alone', async () => {
    const result = await engine.search(work, {
      ...base,
      limit: 20,
      facets: ['creator', 'keyword'],
      facetQueries: { creator: 'dodoens' },
    });

    expect(result.total).toBe(14);
    expect(counts(result.facets.creator as Facet)).toEqual([[rembert, 2]]);
    expect(counts(result.facets.keyword as Facet)).toContainEqual(['boek', 5]);
  });

  it('rejects a query on a reference facet without a label source', async () => {
    await expect(
      engine.searchFacets(work, [
        { ...base, facets: ['genre'], facetQueries: { genre: 'portrait' } },
      ]),
    ).rejects.toThrow(/not-queryable/);
  });
});
