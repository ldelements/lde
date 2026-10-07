import { describe, it, expect } from 'vitest';
import { Dataset, Distribution } from '@lde/dataset';
import {
  predefinedDatasetBindings,
  DATASET_BINDING_VARIABLES,
} from '../../src/sparql/datasetBindings.js';

function makeDataset(
  overrides: Partial<ConstructorParameters<typeof Dataset>[0]> = {},
) {
  const distribution = Distribution.sparql(
    new URL('http://example.org/sparql'),
  );
  return new Dataset({
    iri: new URL('http://example.org/dataset'),
    distributions: [distribution],
    ...overrides,
  });
}

describe('predefinedDatasetBindings', () => {
  it('always includes the dataset IRI', () => {
    const rows = predefinedDatasetBindings(makeDataset());
    expect(rows).toHaveLength(1);
    expect(rows[0]['dataset']).toMatchObject({
      termType: 'NamedNode',
      value: 'http://example.org/dataset',
    });
  });

  it('omits datasetPublisher and datasetLicense when absent', () => {
    const rows = predefinedDatasetBindings(makeDataset());
    expect(rows[0]['datasetPublisher']).toBeUndefined();
    expect(rows[0]['datasetLicense']).toBeUndefined();
  });

  it('includes datasetPublisher and datasetLicense when present', () => {
    const rows = predefinedDatasetBindings(
      makeDataset({
        publisher: {
          iri: new URL('http://example.org/publisher'),
          name: { nl: 'Naam' },
        },
        license: new URL('http://example.org/license'),
      }),
    );

    expect(rows).toHaveLength(1);
    expect(rows[0]['datasetPublisher']).toMatchObject({
      termType: 'NamedNode',
      value: 'http://example.org/publisher',
    });
    expect(rows[0]['datasetLicense']).toMatchObject({
      termType: 'NamedNode',
      value: 'http://example.org/license',
    });
  });

  it('omits datasetLanguage when the dataset has no languages', () => {
    const rows = predefinedDatasetBindings(makeDataset({ language: [] }));
    expect(rows).toHaveLength(1);
    expect(rows[0]['datasetLanguage']).toBeUndefined();
  });

  it('expands one row per language', () => {
    const rows = predefinedDatasetBindings(
      makeDataset({ language: ['nl', 'en'] }),
    );

    expect(rows).toHaveLength(2);
    const languages = rows.map((row) => row['datasetLanguage']?.value);
    expect(languages.sort()).toEqual(['en', 'nl']);
    // Every row still carries the (identical) dataset binding.
    for (const row of rows) {
      expect(row['dataset']).toMatchObject({
        value: 'http://example.org/dataset',
      });
    }
  });

  it('omits datasetPublisherName when the publisher has no name translations', () => {
    const rows = predefinedDatasetBindings(
      makeDataset({
        publisher: { iri: new URL('http://example.org/publisher'), name: {} },
      }),
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]['datasetPublisherName']).toBeUndefined();
  });

  it('expands one row per publisher name translation, tagged with its language', () => {
    const rows = predefinedDatasetBindings(
      makeDataset({
        publisher: {
          iri: new URL('http://example.org/publisher'),
          name: { nl: 'Naam', en: 'Name' },
        },
      }),
    );

    expect(rows).toHaveLength(2);
    const byLang = Object.fromEntries(
      rows.map((row) => [
        (row['datasetPublisherName'] as { language?: string })?.language,
        row['datasetPublisherName']?.value,
      ]),
    );
    expect(byLang).toEqual({ nl: 'Naam', en: 'Name' });
  });

  it('cross-products datasetLanguage and datasetPublisherName independently', () => {
    const rows = predefinedDatasetBindings(
      makeDataset({
        language: ['nl', 'en'],
        publisher: {
          iri: new URL('http://example.org/publisher'),
          name: { nl: 'Naam', en: 'Name' },
        },
      }),
    );

    expect(rows).toHaveLength(4);
    const combinations = new Set(
      rows.map(
        (row) =>
          `${row['datasetLanguage']?.value}/${row['datasetPublisherName']?.value}`,
      ),
    );
    expect(combinations).toEqual(
      new Set(['nl/Naam', 'nl/Name', 'en/Naam', 'en/Name']),
    );
  });
});

describe('DATASET_BINDING_VARIABLES', () => {
  it('lists every predefined reserved name', () => {
    expect(DATASET_BINDING_VARIABLES).toEqual([
      'dataset',
      'datasetPublisher',
      'datasetPublisherName',
      'datasetLicense',
      'datasetLanguage',
    ]);
  });
});
