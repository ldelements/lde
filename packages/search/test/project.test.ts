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
    kind: { type: 'langText', search: true, display: true },
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
    expect(document.title_search).toBe('titel title');
    expect(document.title_sort).toBe('titel');
    expect(document.publisher_search).toBe('erfgoed');
    expect(document.publisher_name).toBe('Erfgoed');
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
      { '@id': 'https://ex/d/2', [`${DCT}title`]: { '@value': 'Solo' } },
      { type: DATASET, fields },
    );
    expect(document.id).toBe('https://ex/d/2');
    expect(document.title_search).toBe('solo');
    expect(document.publisher).toBeUndefined();
    expect(document.size).toBeUndefined();
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
    expect(byId['https://ex/d/1'].title_search).toBe('titel');
    expect(byId['https://ex/d/2'].title_nl).toBe('Andere');
  });
});
