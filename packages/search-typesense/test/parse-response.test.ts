import { describe, expect, it } from 'vitest';
import type { LocalizedValue, SearchSchema } from '@lde/search';
import { parseSearchResponse } from '../src/search.js';

const schema: SearchSchema = {
  type: 'http://www.w3.org/ns/dcat#Dataset',
  fields: [
    {
      name: 'title',
      kind: 'text',
      localized: true,
      locales: ['nl', 'en'],
      output: true,
    },
    {
      name: 'keyword',
      kind: 'keyword',
      array: true,
      facetable: true,
      output: true,
    },
    {
      name: 'publisher',
      kind: 'reference',
      array: true,
      facetable: true,
      output: true,
      ref: { type: 'http://xmlns.com/foaf/0.1/Agent', strategy: 'labelOnly' },
    },
    { name: 'size', kind: 'integer', output: true },
    { name: 'datePosted', kind: 'date', output: true },
    { name: 'iiif', kind: 'boolean', facetable: true, output: true },
    // A non-output field is never reconstructed into the logical document.
    { name: 'status', kind: 'keyword', facetable: true, filterable: true },
  ],
};

const labels = new Map<string, LocalizedValue>([
  ['https://org/1', { nl: ['Het Utrechts Archief'] }],
  ['https://org/2', { nl: ['Rijksmuseum'], en: ['Rijksmuseum'] }],
]);

const response = {
  found: 2,
  hits: [
    {
      document: {
        id: 'https://d/1',
        title_nl: 'Titel',
        title_en: 'Title',
        keyword: ['kaarten'],
        publisher: ['https://org/1'],
        size: 1234,
        datePosted: 1_700_000_000,
        iiif: true,
        status: 'valid',
      },
    },
    {
      document: {
        id: 'https://d/2',
        title_nl: 'Andere',
        keyword: ['atlas', 'kaart'],
        publisher: ['https://org/2', 'https://org/3'],
      },
    },
  ],
  facet_counts: [
    {
      field_name: 'keyword',
      counts: [
        { value: 'kaarten', count: 3 },
        { value: 'atlas', count: 1 },
      ],
    },
    {
      // A reference facet: buckets are keyed by IRI and carry resolved labels.
      field_name: 'publisher',
      counts: [
        { value: 'https://org/1', count: 2 },
        { value: 'https://org/3', count: 1 },
      ],
    },
  ],
};

describe('parseSearchResponse', () => {
  const result = parseSearchResponse(response, schema, labels);

  it('carries the total and the facet buckets keyed by field name', () => {
    expect(result.total).toBe(2);
    // A plain facet: buckets carry no label.
    expect(result.facets.keyword).toEqual([
      { value: 'kaarten', count: 3 },
      { value: 'atlas', count: 1 },
    ]);
  });

  it('attaches resolved labels to reference-facet buckets, id-only when unlabelled', () => {
    expect(result.facets.publisher).toEqual([
      {
        value: 'https://org/1',
        count: 2,
        label: { nl: ['Het Utrechts Archief'] },
      },
      { value: 'https://org/3', count: 1 },
    ]);
  });

  it('reconstructs localized text into a best-available language map', () => {
    expect(result.hits[0].id).toBe('https://d/1');
    expect(result.hits[0].document.title).toEqual({
      nl: ['Titel'],
      en: ['Title'],
    });
    // Only the present locale is emitted.
    expect(result.hits[1].document.title).toEqual({ nl: ['Andere'] });
  });

  it('resolves reference IRIs to labelled references, id-only when unlabelled', () => {
    expect(result.hits[0].document.publisher).toEqual([
      { id: 'https://org/1', label: { nl: ['Het Utrechts Archief'] } },
    ]);
    expect(result.hits[1].document.publisher).toEqual([
      {
        id: 'https://org/2',
        label: { nl: ['Rijksmuseum'], en: ['Rijksmuseum'] },
      },
      { id: 'https://org/3' },
    ]);
  });

  it('passes keyword arrays and numeric scalars through, and omits absent fields', () => {
    expect(result.hits[0].document.keyword).toEqual(['kaarten']);
    expect(result.hits[0].document.size).toBe(1234);
    expect(result.hits[0].document.datePosted).toBe(1_700_000_000);
    expect(result.hits[1].document.size).toBeUndefined();
  });

  it('defaults an absent boolean to false and never reconstructs non-output fields', () => {
    expect(result.hits[0].document.iiif).toBe(true);
    expect(result.hits[1].document.iiif).toBe(false);
    expect(result.hits[0].document.status).toBeUndefined();
  });
});
