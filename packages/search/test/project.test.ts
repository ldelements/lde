import { describe, expect, it } from 'vitest';
import {
  projectDocument,
  irisOf,
  type FieldSpec,
  type Derivation,
} from '../src/project.js';

const DCT = 'http://purl.org/dc/terms/';
const DCAT = 'http://www.w3.org/ns/dcat#';
const DR = 'urn:dr:';
const IANA = 'https://www.iana.org/assignments/media-types/';
const XSD = 'http://www.w3.org/2001/XMLSchema#';

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

describe('projectDocument', () => {
  it('projects every field kind and runs derivations', () => {
    const document = projectDocument(node, fields, derivations);

    expect(document.id).toBe('https://ex/d/1');
    // langText: per-locale display, folded search across languages, folded sort.
    expect(document.title_nl).toBe('Titel');
    expect(document.title_en).toBe('Title');
    expect(document.title_search).toBe('titel title');
    expect(document.title_sort).toBe('titel');
    // langText with single display (no locales).
    expect(document.publisher_search).toBe('erfgoed');
    expect(document.publisher_name).toBe('Erfgoed');
    // facets.
    expect(document.publisher).toEqual(['https://ex/o/1']);
    expect(document.keyword).toEqual(['Erfgoed']);
    expect(document.keyword_search).toEqual(['erfgoed']);
    expect(document.format).toEqual(['text/turtle']);
    expect(document.class).toEqual(['http://schema.org/Person']);
    // numbers.
    expect(document.date_posted).toBe(
      Math.trunc(Date.parse('2024-01-01T00:00:00.000Z') / 1000),
    );
    expect(document.size).toBe(1234);
    // derivation read the framed node directly.
    expect(document.class_count).toBe(1);
  });

  it('coerces exotic JSON-LD value shapes', () => {
    const document = projectDocument(
      {
        '@id': 'https://ex/d/3',
        // numeric @value, boolean @value, a bare-string literal, a bare-string IRI
        [`${DR}size`]: { '@value': 42 },
        [`${DCT}language`]: { '@value': true },
        [`${DCAT}keyword`]: 'bareString',
        [`${DR}class`]: 'http://example.org/BareClass',
      },
      [
        { name: 'size', path: `${DR}size`, kind: { type: 'number' } },
        { name: 'language', path: `${DCT}language`, kind: { type: 'facet' } },
        {
          name: 'keyword',
          path: `${DCAT}keyword`,
          kind: { type: 'facet', search: true },
        },
        { name: 'class', path: `${DR}class`, kind: { type: 'facet', iri: true } },
      ],
    );
    expect(document.size).toBe(42);
    expect(document.language).toEqual(['true']);
    expect(document.keyword).toEqual(['bareString']);
    expect(document.class).toEqual(['http://example.org/BareClass']);
  });

  it('omits absent optional fields', () => {
    const document = projectDocument(
      { '@id': 'https://ex/d/2', [`${DCT}title`]: { '@value': 'Solo' } },
      fields,
    );
    expect(document.id).toBe('https://ex/d/2');
    expect(document.title_search).toBe('solo');
    expect(document.publisher).toBeUndefined();
    expect(document.format).toBeUndefined();
    expect(document.size).toBeUndefined();
  });
});
