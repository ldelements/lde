import { describe, expect, it } from 'vitest';
import { projectDocument } from '../src/project.js';
import {
  copiedDatasetFieldOf,
  datasetTypeOf,
  defineSearchType,
  facetMatchesLabels,
  fieldNamed,
  isQueryableFacet,
  facetNamed,
  readsReferentLabels,
  searchSchema,
  validateSearchType,
  type FacetDeclaration,
  type SearchField,
} from '../src/schema.js';
import { labelMatchValue } from '../src/label-match.js';

const SCHEMA = 'https://schema.org/';
const DCAT_DATASET = 'http://www.w3.org/ns/dcat#Dataset';
const alias = (type: string, field: string) => `urn:lde:${type}/${field}`;

const catalogue = defineSearchType({
  name: 'Catalogue',
  class: DCAT_DATASET,
  labelField: 'title',
  fields: [
    {
      name: 'title',
      kind: 'text',
      path: '<http://purl.org/dc/terms/title>',
      locales: ['nl'],
      output: true,
      searchable: { weight: 1 },
    },
    {
      name: 'publisher',
      kind: 'reference',
      array: true,
      path: '<http://purl.org/dc/terms/publisher>',
      facetable: true,
      ref: { strategy: 'lookup', target: 'Org' },
    },
    {
      name: 'theme',
      kind: 'keyword',
      array: true,
      path: '<http://www.w3.org/ns/dcat#theme>',
      facetable: true,
    },
  ],
});

const org = defineSearchType({
  name: 'Org',
  class: `${SCHEMA}Organization`,
  labelField: 'name',
  fields: [
    {
      name: 'name',
      kind: 'text',
      path: `<${SCHEMA}name>`,
      locales: ['nl'],
      output: true,
      searchable: { weight: 1 },
    },
  ],
});

const work = defineSearchType({
  name: 'Work',
  class: `${SCHEMA}CreativeWork`,
  fields: [
    {
      name: 'dataset',
      kind: 'reference',
      from: 'dataset',
      facetable: true,
      ref: { strategy: 'lookup', target: 'Catalogue' },
    },
    {
      name: 'publisher',
      kind: 'reference',
      array: true,
      from: { dataset: 'publisher' },
      facetable: true,
      ref: { strategy: 'lookup', target: 'Org' },
    },
    {
      name: 'isPartOf',
      kind: 'reference',
      array: true,
      path: `<${SCHEMA}isPartOf>`,
      excludeDataset: true,
      facetable: true,
      ref: { strategy: 'lookup', target: 'Catalogue' },
    },
    {
      // A keyword has its own text to match, and no labels to copy.
      name: 'theme',
      kind: 'keyword',
      array: true,
      from: { dataset: 'theme' },
      facetable: true,
    },
    {
      // Computed: nothing states labels for what it returns.
      name: 'computed',
      kind: 'reference',
      array: true,
      facetable: true,
      ref: { strategy: 'lookup', target: 'Org' },
      derive: () => ['https://ex/org/computed'],
    },
  ],
});

const schema = searchSchema(catalogue, org, work);
const field = (name: string) => fieldNamed(work, name) as SearchField;
const facet = (name: string) =>
  facetNamed(work, name, schema) as FacetDeclaration;

const DATASET = 'https://ex/dataset/1';
const TRACE = 'https://ex/org/trace';
/** The dataset’s own document, as the pipeline projects it first. */
const datasetDocument = {
  id: DATASET,
  title_nl: 'Decoraties',
  publisher: [TRACE],
  publisher_match: [
    labelMatchValue(['Tracé'], TRACE) as string,
    // Stated for a publisher the dataset’s field does not store, and a value
    // another writer put there: neither labels a copied value.
    labelMatchValue(['Elders'], 'https://ex/org/elsewhere') as string,
    'Tracé',
  ],
  theme: ['kaarten'],
};

describe('fields declared over the dataset being indexed', () => {
  it('finds the dataset type and the field a copy names', () => {
    expect(datasetTypeOf(schema)).toBe(catalogue);
    expect(copiedDatasetFieldOf(field('publisher'), schema)).toBe(
      catalogue.fields[1],
    );
    expect(copiedDatasetFieldOf(field('dataset'), schema)).toBeUndefined();
  });

  it('refuses a copy the schema has no dataset field for', () => {
    const copying = (from: { dataset: string }) =>
      defineSearchType({
        ...work,
        name: 'Copying',
        class: `${SCHEMA}Thing`,
        fields: [
          {
            name: 'copied',
            kind: 'reference',
            from,
            ref: { strategy: 'lookup', target: 'Org' },
          },
        ],
      });

    expect(() => searchSchema(org, copying({ dataset: 'publisher' }))).toThrow(
      /declares no type of class “http:\/\/www.w3.org\/ns\/dcat#Dataset”/,
    );
    expect(() =>
      searchSchema(catalogue, org, copying({ dataset: 'title' })),
    ).toThrow(/does not declare as a reference/);
  });

  it('copies only into a Root Type other than the dataset type, and only plain ids', () => {
    const copy = {
      name: 'copied',
      kind: 'reference',
      from: { dataset: 'publisher' },
      ref: { strategy: 'lookup', target: 'Org' },
    } as const;
    // The dataset type copying from itself.
    expect(() =>
      searchSchema(
        defineSearchType({ ...catalogue, fields: [...catalogue.fields, copy] }),
        org,
      ),
    ).toThrow(/only a Root Type other than the dataset type/);
    // A Reference Type, nested in its referrer.
    const nestedCopy = defineSearchType({ name: 'Credit', fields: [copy] });
    const referrer = defineSearchType({
      name: 'Referrer',
      class: `${SCHEMA}Thing`,
      fields: [
        {
          name: 'credit',
          kind: 'reference',
          path: `<${SCHEMA}credit>`,
          output: true,
          ref: { strategy: 'inline', typeName: 'Credit' },
        },
      ],
    });
    expect(() => searchSchema(catalogue, org, nestedCopy, referrer)).toThrow(
      /only a Root Type other than the dataset type/,
    );
    // A local lookup stores nested documents, not ids.
    const localCatalogue = defineSearchType({
      ...catalogue,
      fields: [
        catalogue.fields[0],
        {
          ...catalogue.fields[1],
          ref: { strategy: 'lookup', target: 'Org', local: true },
        },
      ],
    });
    expect(() => searchSchema(localCatalogue, org, work)).toThrow(
      /stores nested documents rather than ids/,
    );
    // The copied values are transformed already.
    const transforming = defineSearchType({
      ...work,
      fields: [{ ...copy, transform: (value: string) => value }],
    });
    expect(() => searchSchema(catalogue, org, transforming)).toThrow(
      /declares a “transform”/,
    );
  });

  it('searches no facet by label that the dataset type declares over itself, or that names no label source', () => {
    const selfDescribing = defineSearchType({
      ...catalogue,
      fields: [
        ...catalogue.fields,
        {
          name: 'dataset',
          kind: 'reference',
          from: 'dataset',
          facetable: true,
          ref: { strategy: 'lookup', target: 'Catalogue' },
        },
      ],
    });
    const unlabelled = defineSearchType({
      ...work,
      fields: [
        {
          name: 'publisher',
          kind: 'reference',
          from: { dataset: 'publisher' },
          facetable: true,
          ref: { strategy: 'idOnly' },
        },
      ],
    });
    const other = searchSchema(selfDescribing, org, unlabelled);

    expect(
      facetMatchesLabels(selfDescribing.fields[3] as SearchField, other),
    ).toBe(false);
    expect(facetMatchesLabels(unlabelled.fields[0] as SearchField, other)).toBe(
      false,
    );
  });

  it('refuses excludeDataset on a reference read from no path', () => {
    expect(
      validateSearchType(
        defineSearchType({
          ...work,
          fields: [
            {
              name: 'dataset',
              kind: 'reference',
              from: 'dataset',
              excludeDataset: true,
              ref: { strategy: 'lookup', target: 'Catalogue' },
            },
          ],
        }),
      ),
    ).toContainEqual(
      expect.objectContaining({ reason: 'exclude-dataset-without-path' }),
    );
  });

  it('searches a facet by label wherever its values come with labels, never a computed one', () => {
    expect(facetMatchesLabels(field('dataset'), schema)).toBe(true);
    expect(facetMatchesLabels(field('publisher'), schema)).toBe(true);
    expect(facetMatchesLabels(field('isPartOf'), schema)).toBe(true);
    expect(facetMatchesLabels(field('computed'), schema)).toBe(false);
    // Only a path-read reference has its labels read beside it.
    expect(readsReferentLabels(field('isPartOf'), schema)).toBe(true);
    expect(readsReferentLabels(field('publisher'), schema)).toBe(false);
    expect(isQueryableFacet(facet('publisher'), schema)).toBe(true);
  });

  it('pairs the dataset and its copied publisher with the labels the dataset’s document states', () => {
    const document = projectDocument(
      { '@id': 'https://ex/work/1' },
      work,
      schema,
      { dataset: DATASET, datasetDocument },
    );

    expect(document.dataset).toBe(DATASET);
    expect(document.dataset_match).toBe(
      labelMatchValue(['Decoraties'], DATASET),
    );
    expect(document.publisher).toEqual([TRACE]);
    expect(document.publisher_match).toEqual([
      labelMatchValue(['Tracé'], TRACE),
    ]);
    expect(document.theme).toEqual(['kaarten']);
    // Computed values carry no labels, so no companion.
    expect(document.computed).toEqual(['https://ex/org/computed']);
    expect(document).not.toHaveProperty('computed_match');
  });

  it('copies nothing without the dataset’s document', () => {
    const document = projectDocument(
      { '@id': 'https://ex/work/1' },
      work,
      schema,
      { dataset: DATASET },
    );

    expect(document).not.toHaveProperty('publisher');
    expect(document.dataset).toBe(DATASET);
    expect(document).not.toHaveProperty('dataset_match');
  });

  it('leaves the dataset itself out of a path that reaches it', () => {
    const document = projectDocument(
      {
        '@id': 'https://ex/work/1',
        [alias('Work', 'isPartOf')]: [
          {
            '@id': DATASET,
            [alias('Catalogue', 'title')]: [
              { '@value': 'Decoraties', '@language': 'nl' },
            ],
          },
          {
            '@id': 'https://ex/collection/1',
            [alias('Catalogue', 'title')]: [
              { '@value': 'Bewegend beeld', '@language': 'nl' },
            ],
          },
        ],
      },
      work,
      schema,
      { dataset: DATASET },
    );

    expect(document.isPartOf).toEqual(['https://ex/collection/1']);
    expect(document.isPartOf_match).toEqual([
      labelMatchValue(['Bewegend beeld'], 'https://ex/collection/1'),
    ]);
  });
});
