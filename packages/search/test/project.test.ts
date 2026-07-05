import { describe, expect, it } from 'vitest';
import { Parser } from 'n3';
import { dcat, dcterms, rdf, xsd } from '@tpluscode/rdf-ns-builders';
import {
  projectDocument,
  projectGraph,
  irisOf,
  type SearchDocument,
} from '../src/project.js';
import {
  searchSchema,
  type SearchField,
  type SearchType,
} from '../src/schema.js';

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

const fields: SearchField[] = [
  {
    name: 'title',
    path: dcterms.title.value,
    kind: 'text',
    localized: true,
    locales: ['nl', 'en'],
    output: true,
    searchable: { weight: 1 },
    sortable: true,
  },
  {
    name: 'publisherName',
    path: `${DR}publisherName`,
    kind: 'text',
    localized: true,
    locales: ['nl', 'en'],
    output: true,
    searchable: { weight: 1 },
  },
  {
    name: 'publisher',
    path: dcterms.publisher.value,
    kind: 'reference',
  },
  {
    name: 'keyword',
    path: dcat.keyword.value,
    kind: 'keyword',
    searchable: { weight: 1 },
  },
  {
    name: 'format',
    path: `${DR}format`,
    kind: 'keyword',
    transform: (value) => value.replace(IANA, ''),
  },
  { name: 'class', path: `${DR}class`, kind: 'reference' },
  {
    name: 'date_posted',
    path: `${DR}datePosted`,
    kind: 'date',
  },
  { name: 'size', path: `${DR}size`, kind: 'integer' },
];

const schema: SearchType = {
  name: 'Dataset',
  type: DATASET,
  fields: [
    ...fields,
    {
      name: 'class_count',
      kind: 'integer',
      derive: (framed) => irisOf(framed, `${DR}class`).length,
    },
  ],
};

describe('projectDocument', () => {
  it('projects every field kind and computes derived fields', () => {
    const document = projectDocument(node, schema);

    expect(document.id).toBe('https://ex/d/1');
    expect(document.title_nl).toBe('Titel');
    expect(document.title_en).toBe('Title');
    expect(document.title_search_nl).toBe('titel');
    expect(document.title_search_en).toBe('title');
    expect(document.title_sort_nl).toBe('titel');
    expect(document.title_sort_en).toBe('title');
    expect(document.publisherName_nl).toBe('Erfgoed');
    expect(document.publisherName_search_nl).toBe('erfgoed');
    expect(document.publisherName_en).toBeUndefined();
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
        name: 'Dataset',
        type: DATASET,
        fields: [
          { name: 'size', path: `${DR}size`, kind: 'integer' },
          {
            name: 'language',
            path: dcterms.language.value,
            kind: 'keyword',
          },
          {
            name: 'keyword',
            path: dcat.keyword.value,
            kind: 'keyword',
            searchable: { weight: 1 },
          },
          {
            name: 'class',
            path: `${DR}class`,
            kind: 'reference',
          },
        ],
      },
    );
    expect(document.size).toBe(42);
    expect(document.language).toEqual(['true']);
    expect(document.keyword).toEqual(['bareString']);
    expect(document.class).toEqual(['http://example.org/BareClass']);
  });

  it('projects a number field as a float (not truncated like integer)', () => {
    const document = projectDocument(
      { '@id': 'https://ex/d/12', [`${DR}size`]: { '@value': '1234.5' } },
      {
        name: 'Dataset',
        type: DATASET,
        fields: [{ name: 'size', path: `${DR}size`, kind: 'number' }],
      },
    );
    expect(document.size).toBe(1234.5);
  });

  it('projects a boolean field from a path (xsd:boolean lexical space)', () => {
    const withBoolean: SearchType = {
      name: 'Dataset',
      type: DATASET,
      fields: [{ name: 'iiif', path: `${DR}iiif`, kind: 'boolean' }],
    };
    const project = (value: unknown): SearchDocument =>
      projectDocument(
        { '@id': 'https://ex/d/5', [`${DR}iiif`]: { '@value': value } },
        withBoolean,
      );

    expect(project('true').iiif).toBe(true);
    expect(project('1').iiif).toBe(true);
    expect(project('false').iiif).toBe(false);
    // Absent value → no field (the adapter reconstructs absence as false).
    expect(
      projectDocument({ '@id': 'https://ex/d/5' }, withBoolean).iiif,
    ).toBeUndefined();
  });

  it('folds the transformed values (not the raw ones) for a facet search field', () => {
    const document = projectDocument(
      { '@id': 'https://ex/d/4', [`${DR}format`]: [`${IANA}text/turtle`] },
      {
        name: 'Dataset',
        type: DATASET,
        fields: [
          {
            name: 'format',
            path: `${DR}format`,
            kind: 'keyword',
            searchable: { weight: 1 },
            transform: (value) => value.replace(IANA, ''),
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
      { name: 'Dataset', type: DATASET, fields },
    );
    expect(document.id).toBe('https://ex/d/2');
    expect(document.title_search_nl).toBe('solo');
    expect(document.publisher).toBeUndefined();
    expect(document.size).toBeUndefined();
  });

  it('omits the sort field when there is no value to sort on', () => {
    const document = projectDocument(
      { '@id': 'https://ex/d/5' },
      { name: 'Dataset', type: DATASET, fields },
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
      { name: 'Dataset', type: DATASET, fields },
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
      { name: 'Dataset', type: DATASET, fields },
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
        name: 'Dataset',
        type: DATASET,
        fields: [
          {
            name: 'title',
            path: dcterms.title.value,
            // search only — display (output) and sort not opted into.
            kind: 'text',
            localized: true,
            locales: ['nl', 'en'],
            searchable: { weight: 1 },
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
      { name: 'Dataset', type: DATASET, fields },
    );
    // Display takes the first value; search folds them all so both are matchable.
    expect(document.title_nl).toBe('Titel');
    expect(document.title_search_nl).toBe('titel ondertitel');
  });

  it('computes a derived field via derive, which may read earlier fields', () => {
    const document = projectDocument(
      {
        '@id': 'https://ex/d/11',
        [dcterms.title.value]: { '@language': 'nl', '@value': 'Titel' },
      },
      {
        name: 'Dataset',
        type: DATASET,
        fields: [
          {
            name: 'title',
            path: dcterms.title.value,
            kind: 'text',
            localized: true,
            locales: ['nl'],
            output: true,
          },
          // No `path`: a derived field — computed by `derive`, never
          // projected.
          {
            name: 'status',
            kind: 'keyword',
            facetable: true,
            derive: () => 'valid',
          },
          // Runs after `status` (declaration order), so it can read it.
          {
            name: 'statusRank',
            kind: 'integer',
            sortable: true,
            derive: (_node, partial) => (partial.status === 'valid' ? 1 : 0),
          },
          // Returning undefined leaves the field absent.
          { name: 'absent', kind: 'keyword', derive: () => undefined },
          // Neither path nor derive: populated outside the projection, if at
          // all — skipped here.
          { name: 'external', kind: 'keyword' },
        ],
      },
    );
    expect(document.title_nl).toBe('Titel');
    expect(document.status).toBe('valid');
    expect(document.statusRank).toBe(1);
    expect(document).not.toHaveProperty('absent');
    expect(document).not.toHaveProperty('external');
  });

  it('projects a monolingual text field: display value + folded search, any tag', () => {
    const document = projectDocument(
      {
        '@id': 'https://ex/d/13',
        [dcterms.title.value]: [
          { '@language': 'nl', '@value': 'Café' },
          'Untagged subtitle',
        ],
      },
      {
        name: 'Dataset',
        type: DATASET,
        fields: [
          {
            name: 'title',
            path: dcterms.title.value,
            kind: 'text',
            output: true,
            sortable: true,
            searchable: { weight: 3 },
          },
          // No values at this path: nothing is emitted.
          { name: 'subtitle', path: 'urn:dr:none', kind: 'text', output: true },
          // Search-only: folded companion, no display value.
          {
            name: 'note',
            path: dcterms.title.value,
            kind: 'text',
            searchable: { weight: 1 },
          },
        ],
      },
    );
    // Display keeps accents; search folds every value regardless of tag.
    expect(document.title).toBe('Café');
    expect(document.title_search).toBe('cafe untagged subtitle');
    expect(document).not.toHaveProperty('subtitle');
    expect(document).not.toHaveProperty('note');
    expect(document.note_search).toBe('cafe untagged subtitle');
  });

  it('ignores IR values it cannot read (non-literal @value, node without @id)', () => {
    const document = projectDocument(
      {
        '@id': 'https://ex/d/12',
        [dcterms.title.value]: [
          { '@language': 'nl', '@value': 'Titel' },
          { '@language': 'nl', '@value': { nested: true } },
        ],
        [dcat.keyword.value]: [{ '@value': { nested: true } }, 'kaart'],
        [dcterms.publisher.value]: [{ nested: true }, { '@id': 'https://o/1' }],
      },
      {
        name: 'Dataset',
        type: DATASET,
        fields: [
          {
            name: 'title',
            path: dcterms.title.value,
            kind: 'text',
            localized: true,
            locales: ['nl'],
            output: true,
          },
          { name: 'keyword', path: dcat.keyword.value, kind: 'keyword' },
          {
            name: 'publisher',
            path: dcterms.publisher.value,
            kind: 'reference',
          },
        ],
      },
    );
    expect(document.title_nl).toBe('Titel');
    expect(document.keyword).toEqual(['kaart']);
    expect(document.publisher).toEqual(['https://o/1']);
  });

  it('throws when the framed node has no @id', () => {
    expect(() =>
      projectDocument(
        { [dcterms.title.value]: { '@value': 'No id' } },
        { name: 'Dataset', type: DATASET, fields },
      ),
    ).toThrow(/without an @id/);
  });

  it('projects nothing for a localized field with no locales (rejected at declaration time)', () => {
    // validateSearchType owns the empty-locales rule; the projection itself
    // stays total for hand-built maps that bypassed searchSchema().
    const document = projectDocument(
      {
        '@id': 'https://ex/d/9',
        [dcterms.title.value]: { '@language': 'nl', '@value': 'Titel' },
      },
      {
        name: 'Dataset',
        type: DATASET,
        fields: [
          {
            name: 'title',
            path: dcterms.title.value,
            kind: 'text',
            localized: true,
            locales: [],
          },
        ],
      },
    );
    expect(document).toEqual({ id: 'https://ex/d/9' });
  });
});

describe('projectGraph', () => {
  it('frames each root type in the schema and projects matching nodes', async () => {
    const quads = new Parser({ format: 'N-Triples' }).parse(`
      <https://ex/d/1> <${rdf.type.value}> <${DATASET}> .
      <https://ex/d/1> <${dcterms.title.value}> "Titel"@nl .
      <https://ex/d/2> <${rdf.type.value}> <${DATASET}> .
      <https://ex/d/2> <${dcterms.title.value}> "Andere"@nl .
      <https://ex/x/1> <${rdf.type.value}> <http://example.org/Other> .
      <https://ex/x/1> <${dcterms.title.value}> "Ignored"@nl .
    `);

    const documents: SearchDocument[] = [];
    for await (const document of projectGraph(
      quads,
      searchSchema({ name: 'Dataset', type: DATASET, fields }),
    )) {
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
