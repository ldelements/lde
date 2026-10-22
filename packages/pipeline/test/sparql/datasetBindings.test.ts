import { describe, it, expect } from 'vitest';
import { Dataset, Distribution } from '@lde/dataset';
import { DataFactory } from 'n3';
import { predefinedDatasetBindings } from '../../src/sparql/datasetBindings.js';

const { namedNode, literal } = DataFactory;

const dataset = namedNode('http://example.org/dataset');
const publisher = {
  iri: new URL('http://example.org/publisher'),
  name: { nl: 'Naam', en: 'Name' },
};

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
  it('binds only the dataset IRI when no optional properties are present', () => {
    expect(predefinedDatasetBindings(makeDataset({ language: [] }))).toEqual([
      { dataset },
    ]);
  });

  it('includes datasetPublisher and datasetLicense when present', () => {
    const rows = predefinedDatasetBindings(
      makeDataset({
        publisher: { ...publisher, name: {} },
        license: new URL('http://example.org/license'),
      }),
    );

    expect(rows).toEqual([
      {
        dataset,
        datasetPublisher: namedNode('http://example.org/publisher'),
        datasetLicense: namedNode('http://example.org/license'),
      },
    ]);
  });

  it('expands one row per language', () => {
    const rows = predefinedDatasetBindings(
      makeDataset({ language: ['nl', 'en'] }),
    );

    expect(rows).toEqual([
      { dataset, datasetLanguage: literal('nl') },
      { dataset, datasetLanguage: literal('en') },
    ]);
  });

  it('expands one row per publisher name translation, tagged with its language', () => {
    const rows = predefinedDatasetBindings(makeDataset({ publisher }));

    const datasetPublisher = namedNode('http://example.org/publisher');
    expect(rows).toEqual([
      {
        dataset,
        datasetPublisher,
        datasetPublisherName: literal('Naam', 'nl'),
      },
      {
        dataset,
        datasetPublisher,
        datasetPublisherName: literal('Name', 'en'),
      },
    ]);
  });

  it('cross-products datasetLanguage and datasetPublisherName independently', () => {
    const rows = predefinedDatasetBindings(
      makeDataset({ language: ['nl', 'en'], publisher }),
    );

    expect(
      rows.map((row) => [
        row['datasetLanguage'].value,
        row['datasetPublisherName'].value,
      ]),
    ).toEqual([
      ['nl', 'Naam'],
      ['nl', 'Name'],
      ['en', 'Naam'],
      ['en', 'Name'],
    ]);
  });
});
