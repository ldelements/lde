import { describe, expect, it } from 'vitest';
import { Parser } from 'n3';
import { dcat, dcterms, rdf, xsd } from '@tpluscode/rdf-ns-builders';
import {
  projectDocument,
  projectGraph,
  irisOf,
  type FieldSpec,
  type Derivation,
  type Projection,
  type SearchDocument,
} from '../src/project.js';

const DR = 'urn:dr:';
const IANA = 'https://www.iana.org/assignments/media-types/';
const DATASET = dcat.Dataset.value;

const node = {
  '@id': 'https://ex/d/1',
  [dcterms.title.value]: [
    { '@language': 'nl', '@value': 'Titel' },
    { '@language': 'en', '@value': 'Title' },
  ],
  [dcterms.publisher.value]: { '@id': 'https://ex/o/1' },
  [`${DR}publisherName`]: { '@language': 'nl', '@value': 'Erfgoed' },
  [dcat.keyword.value]: [{ '@language': 'nl', '@value': 'Erfgoed' }],
  [`${DR}format`]: [`${IANA}text/turtle`],
  [`${DR}class`]: [{ '@id': 'http://schema.org/Person' }],
  [`${DR}datePosted`]: { '@value': '2024-01-01T00:00:00.000Z' },
  [`${DR}size`]: { '@type': xsd.integer.value, '@value': '1234' },
};

const fields: FieldSpec[] = [
  {
    name: 'title',
    path: dcterms.title.value,
    kind: {
      type: 'langText',
      locales: ['nl', 'en'],
      display: true,
      search: true,
      sort: true,
    },
  },
  {
    name: 'publisher',
    path: `${DR}publisherName`,
    kind: {
      type: 'langText',
      locales: ['nl', 'en'],
      display: true,
      search: true,
    },
  },
  {
    name: 'publisher',
    path: dcterms.publisher.value,
    kind: { type: 'facet', iri: true },
  },
  {
    name: 'keyword',
    path: dcat.keyword.value,
    kind: { type: 'facet', search: true },
  },
  {
    name: 'format',
    path: `${DR}format`,
    kind: { type: 'facet', transform: (value) => value.replace(IANA, '') },
  },
  { name: 'class', path: `${DR}class`, kind: { type: 'facet', iri: true } },
  {
    name: 'date_posted',
    path: `${DR}datePosted`,
    kind: { type: 'number', date: true },
  },
  { name: 'size', path: `${DR}size`, kind: { type: 'number' } },
];

const derivations: Derivation[] = [
  (document, framed) => {
    document.class_count = irisOf(framed, `${DR}class`).length;
  },
];

const projection: Projection = { type: DATASET, fields, derivations };

describe('projectDocument', () => {
  it('projects every field kind and runs derivations', () => {
    const document = projectDocument(node, projection);

    expect(document.id).toBe('https://ex/d/1');
    expect(document.title_nl).toBe('Titel');
    expect(document.title_en).toBe('Title');
    expect(document.title_search_nl).toBe('titel');
    expect(document.title_search_en).toBe('title');
    expect(document.title_sort_nl).toBe('titel');
    expect(document.title_sort_en).toBe('title');
    expect(document.publisher_nl).toBe('Erfgoed');
    expect(document.publisher_search_nl).toBe('erfgoed');
    expect(document.publisher_en).toBeUndefined();
    expect(document.publisher).toEqual(['https://ex/o/1']);
    expect(document.keyword).toEqual(['Erfgoed']);
    expect(document.keyword_search).toEqual(['erfgoed']);
    expect(document.format).toEqual(['text/turtle']);
    expect(document.class).toEqual(['http://schema.org/Person']);
    expect(document.date_posted).toBe(
      Math.trunc(Date.parse('2024-01-01T00:00:00.000Z') / 1000),
    );
    expect(document.size).toBe(1234);
    expect(document.class_count).toBe(1);
  });

  it('coerces exotic JSON-LD value shapes', () => {
    const document = projectDocument(
      {
        '@id': 'https://ex/d/3',
        [`${DR}size`]: { '@value': 42 },
        [dcterms.language.value]: { '@value': true },
        [dcat.keyword.value]: 'bareString',
        [`${DR}class`]: 'http://example.org/BareClass',
      },
      {
        type: DATASET,
        fields: [
          { name: 'size', path: `${DR}size`, kind: { type: 'number' } },
          {
            name: 'language',
            path: dcterms.language.value,
            kind: { type: 'facet' },
          },
          {
            name: 'keyword',
            path: dcat.keyword.value,
            kind: { type: 'facet', search: true },
          },
          {
            name: 'class',
            path: `${DR}class`,
            kind: { type: 'facet', iri: true },
          },
        ],
      },
    );
    expect(document.size).toBe(42);
    expect(document.language).toEqual(['true']);
    expect(document.keyword).toEqual(['bareString']);
    expect(document.class).toEqual(['http://example.org/BareClass']);
  });

  it('folds the transformed values (not the raw ones) for a facet search field', () => {
    const document = projectDocument(
      { '@id': 'https://ex/d/4', [`${DR}format`]: [`${IANA}text/turtle`] },
      {
        type: DATASET,
        fields: [
          {
            name: 'format',
            path: `${DR}format`,
            kind: {
              type: 'facet',
              search: true,
              transform: (value) => value.replace(IANA, ''),
            },
          },
        ],
      },
    );
    expect(document.format).toEqual(['text/turtle']);
    expect(document.format_search).toEqual(['text/turtle']);
  });

  it('omits absent optional fields', () => {
    const document = projectDocument(
      {
        '@id': 'https://ex/d/2',
        [dcterms.title.value]: { '@language': 'nl', '@value': 'Solo' },
      },
      { type: DATASET, fields },
    );
    expect(document.id).toBe('https://ex/d/2');
    expect(document.title_search_nl).toBe('solo');
    expect(document.publisher).toBeUndefined();
    expect(document.size).toBeUndefined();
  });

  it('omits the sort field when there is no value to sort on', () => {
    const document = projectDocument(
      { '@id': 'https://ex/d/5' },
      { type: DATASET, fields },
    );
    expect(document.id).toBe('https://ex/d/5');
    expect(document.title_sort_nl).toBeUndefined();
  });

  it('does not index a value whose language is not in locales', () => {
    const document = projectDocument(
      {
        '@id': 'https://ex/d/6',
        [dcterms.title.value]: { '@language': 'fr', '@value': 'Bonjour' },
      },
      { type: DATASET, fields },
    );
    // locales is ['nl', 'en'], so the French title is invisible — no display,
    // search or sort field is emitted for it.
    expect(document.title_nl).toBeUndefined();
    expect(document.title_en).toBeUndefined();
    expect(document.title_search_nl).toBeUndefined();
    expect(document.title_sort_nl).toBeUndefined();
  });

  it('does not project an untagged literal (no matching locale)', () => {
    const document = projectDocument(
      {
        '@id': 'https://ex/d/7',
        [dcterms.title.value]: { '@value': 'Naamloos' },
      },
      { type: DATASET, fields },
    );
    expect(document.title_nl).toBeUndefined();
    expect(document.title_search_nl).toBeUndefined();
    expect(document.title_en).toBeUndefined();
  });

  it('emits only the families a field opts into (search-only: no display)', () => {
    const document = projectDocument(
      {
        '@id': 'https://ex/d/10',
        [dcterms.title.value]: { '@language': 'nl', '@value': 'Verhalen' },
      },
      {
        type: DATASET,
        fields: [
          {
            name: 'title',
            path: dcterms.title.value,
            // search only — display and sort not opted into.
            kind: { type: 'langText', locales: ['nl', 'en'], search: true },
          },
        ],
      },
    );
    // Search field is emitted; the per-locale display label is not.
    expect(document.title_search_nl).toBe('verhalen');
    expect(document.title_nl).toBeUndefined();
    expect(document.title_sort_nl).toBeUndefined();
  });

  it('folds every value of a locale into its search field', () => {
    const document = projectDocument(
      {
        '@id': 'https://ex/d/8',
        [dcterms.title.value]: [
          { '@language': 'nl', '@value': 'Titel' },
          { '@language': 'nl', '@value': 'Ondertitel' },
        ],
      },
      { type: DATASET, fields },
    );
    // Display takes the first value; search folds them all so both are matchable.
    expect(document.title_nl).toBe('Titel');
    expect(document.title_search_nl).toBe('titel ondertitel');
  });

  it('throws when the framed node has no @id', () => {
    expect(() =>
      projectDocument(
        { [dcterms.title.value]: { '@value': 'No id' } },
        { type: DATASET, fields },
      ),
    ).toThrow(/without an @id/);
  });

  it('throws when a langText field declares no locales', () => {
    expect(() =>
      projectDocument(
        {
          '@id': 'https://ex/d/9',
          [dcterms.title.value]: { '@language': 'nl', '@value': 'Titel' },
        },
        {
          type: DATASET,
          fields: [
            {
              name: 'title',
              path: dcterms.title.value,
              kind: { type: 'langText', locales: [] },
            },
          ],
        },
      ),
    ).toThrow(/at least one locale/);
  });
});

describe('projectGraph', () => {
  it('frames each projection’s type and projects matching nodes', async () => {
    const quads = new Parser({ format: 'N-Triples' }).parse(`
      <https://ex/d/1> <${rdf.type.value}> <${DATASET}> .
      <https://ex/d/1> <${dcterms.title.value}> "Titel"@nl .
      <https://ex/d/2> <${rdf.type.value}> <${DATASET}> .
      <https://ex/d/2> <${dcterms.title.value}> "Andere"@nl .
      <https://ex/x/1> <${rdf.type.value}> <http://example.org/Other> .
      <https://ex/x/1> <${dcterms.title.value}> "Ignored"@nl .
    `);

    const documents: SearchDocument[] = [];
    for await (const document of projectGraph(quads, [
      { type: DATASET, fields },
    ])) {
      documents.push(document);
    }

    const ids = documents.map((document) => document.id).sort();
    expect(ids).toEqual(['https://ex/d/1', 'https://ex/d/2']);
    const byId = Object.fromEntries(
      documents.map((document) => [document.id, document]),
    );
    expect(byId['https://ex/d/1'].title_search_nl).toBe('titel');
    expect(byId['https://ex/d/2'].title_nl).toBe('Andere');
  });
});
