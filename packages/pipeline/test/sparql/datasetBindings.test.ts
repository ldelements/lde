import { describe, it, expect } from 'vitest';
import { Dataset, Distribution } from '@lde/dataset';
import { DataFactory } from 'n3';
import {
  datasetBindingsFor,
  predefinedDatasetBindings,
} from '../../src/sparql/datasetBindings.js';

const { namedNode, literal } = DataFactory;

const dataset = namedNode('http://example.org/dataset');
const nld = 'http://publications.europa.eu/resource/authority/language/NLD';
const eng = 'http://publications.europa.eu/resource/authority/language/ENG';
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
  const datasetPublisher = namedNode('http://example.org/publisher');

  it('binds only the dataset IRI when no optional properties are present', () => {
    expect(predefinedDatasetBindings(makeDataset({ language: [] }))).toEqual([
      [{ dataset }],
      [],
      [],
    ]);
  });

  it('groups datasetPublisher and datasetLicense with the dataset IRI', () => {
    const groups = predefinedDatasetBindings(
      makeDataset({
        publisher: { ...publisher, name: {} },
        license: new URL('http://example.org/license'),
      }),
    );

    expect(groups).toEqual([
      [
        {
          dataset,
          datasetPublisher,
          datasetLicense: namedNode('http://example.org/license'),
        },
      ],
      [],
      [],
    ]);
  });

  it('keeps languages and publisher names in independent groups', () => {
    const groups = predefinedDatasetBindings(
      makeDataset({ language: [nld, eng], publisher }),
    );

    expect(groups).toEqual([
      [{ dataset, datasetPublisher }],
      [
        { datasetLanguage: namedNode(nld) },
        { datasetLanguage: namedNode(eng) },
      ],
      [
        { datasetPublisherName: literal('Naam', 'nl') },
        { datasetPublisherName: literal('Name', 'en') },
      ],
    ]);
  });

  it('binds an untagged publisher name as a plain literal', () => {
    const groups = predefinedDatasetBindings(
      makeDataset({ publisher: { ...publisher, name: { '': 'Naam' } } }),
    );

    expect(groups[2]).toEqual([{ datasetPublisherName: literal('Naam') }]);
  });
});

describe('datasetBindingsFor', () => {
  const type = namedNode('urn:Type');

  it('adds custom rows as one more group', () => {
    expect(datasetBindingsFor(makeDataset(), [{ type }])).toEqual([
      [{ dataset }],
      [],
      [],
      [{ type }],
    ]);
  });

  it('lets a custom row replace a predefined binding of the same name', () => {
    const other = namedNode('urn:other');

    expect(
      datasetBindingsFor(makeDataset({ language: [nld] }), [
        { datasetLanguage: other },
      ]),
    ).toEqual([[{ dataset }], [{}], [], [{ datasetLanguage: other }]]);
  });
});
