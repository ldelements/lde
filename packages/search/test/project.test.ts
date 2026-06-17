import { describe, expect, it } from 'vitest';
import { Parser } from 'n3';
import {
  projectDocument,
  projectGraph,
  irisOf,
  type FieldSpec,
  type Derivation,
  type Projection,
  type SearchDocument,
} from '../src/project.js';

const RDF = 'http://www.w3.org/1999/02/22-rdf-syntax-ns#';
const DCT = 'http://purl.org/dc/terms/';
const DCAT = 'http://www.w3.org/ns/dcat#';
const DR = 'urn:dr:';
const IANA = 'https://www.iana.org/assignments/media-types/';
const XSD = 'http://www.w3.org/2001/XMLSchema#';
const DATASET = `${DCAT}Dataset`;

const node = {
  '@id': 'https://ex/d/1',
  [`${DCT}title`]: [
    { '@language': 'nl', '@value': 'Titel' },
    { '@language': 'en', '@value': 'Title' },
  ],
  [`${DCT}publisher`]: { '@id': 'https://ex/o/1' },
  [`${DR}publisherName`]: { '@language': 'nl', '@value': 'Erfgoed' },
  [`${DCAT}keyword`]: [{ '@language': 'nl', '@value': 'Erfgoed' }],
  [`${DR}format`]: [`${IANA}text/turtle`],
  [`${DR}class`]: [{ '@id': 'http://schema.org/Person' }],
  [`${DR}datePosted`]: { '@value': '2024-01-01T00:00:00.000Z' },
  [`${DR}size`]: { '@type': `${XSD}integer`, '@value': '1234' },
};

const fields: FieldSpec[] = [
  {
    name: 'title',
    path: `${DCT}title`,
    kind: { type: 'langText', locales: ['nl', 'en'], search: true, sort: true },
  },
  {
    name: 'publisher',
    path: `${DR}publisherName`,
    kind: { type: 'langText', locales: ['nl', 'en'], search: true },
  },
  {
    name: 'publisher',
    path: `${DCT}publisher`,
    kind: { type: 'facet', iri: true },
  },
  {
    name: 'keyword',
    path: `${DCAT}keyword`,
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
        [`${DCT}language`]: { '@value': true },
        [`${DCAT}keyword`]: 'bareString',
        [`${DR}class`]: 'http://example.org/BareClass',
      },
      {
        type: DATASET,
        fields: [
          { name: 'size', path: `${DR}size`, kind: { type: 'number' } },
          { name: 'language', path: `${DCT}language`, kind: { type: 'facet' } },
          {
            name: 'keyword',
            path: `${DCAT}keyword`,
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
        [`${DCT}title`]: { '@language': 'nl', '@value': 'Solo' },
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
        [`${DCT}title`]: { '@language': 'fr', '@value': 'Bonjour' },
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

  it('maps untagged literals into the configured untaggedLanguage', () => {
    const document = projectDocument(
      { '@id': 'https://ex/d/7', [`${DCT}title`]: { '@value': 'Naamloos' } },
      { type: DATASET, fields },
      { untaggedLanguage: 'nl' },
    );
    expect(document.title_nl).toBe('Naamloos');
    expect(document.title_search_nl).toBe('naamloos');
    expect(document.title_sort_nl).toBe('naamloos');
    expect(document.title_en).toBeUndefined();
  });

  it('folds every value of a locale into its search field', () => {
    const document = projectDocument(
      {
        '@id': 'https://ex/d/8',
        [`${DCT}title`]: [
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
        { [`${DCT}title`]: { '@value': 'No id' } },
        { type: DATASET, fields },
      ),
    ).toThrow(/without an @id/);
  });

  it('throws when a langText field declares no locales', () => {
    expect(() =>
      projectDocument(
        {
          '@id': 'https://ex/d/9',
          [`${DCT}title`]: { '@language': 'nl', '@value': 'Titel' },
        },
        {
          type: DATASET,
          fields: [
            {
              name: 'title',
              path: `${DCT}title`,
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
      <https://ex/d/1> <${RDF}type> <${DATASET}> .
      <https://ex/d/1> <${DCT}title> "Titel"@nl .
      <https://ex/d/2> <${RDF}type> <${DATASET}> .
      <https://ex/d/2> <${DCT}title> "Andere"@nl .
      <https://ex/x/1> <${RDF}type> <http://example.org/Other> .
      <https://ex/x/1> <${DCT}title> "Ignored"@nl .
    `);

    const documents: SearchDocument[] = [];
    for await (const document of projectGraph(quads, [
      { type: DATASET, fields },
    ])) {
      documents.push(document);
    }

    const ids = documents.map((document) => document.id).sort();
    expect(ids).toEqual(['https://ex/d/1', 'https://ex/d/2']);
    const byId = Object.fromEntries(documents.map((d) => [d.id, d]));
    expect(byId['https://ex/d/1'].title_search_nl).toBe('titel');
    expect(byId['https://ex/d/2'].title_nl).toBe('Andere');
  });
});
