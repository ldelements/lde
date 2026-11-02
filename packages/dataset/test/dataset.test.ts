import { describe, expect, it } from 'vitest';
import { Dataset } from '../src/dataset.js';

describe('Dataset.localFile', () => {
  it('creates a dataset of one local file, identified by its URL', () => {
    const dataset = Dataset.localFile('/rdf/catalog.ttl');

    expect(dataset).toBeInstanceOf(Dataset);
    expect(dataset.iri.toString()).toBe('file:///rdf/catalog.ttl');
    expect(dataset.distributions).toHaveLength(1);
    expect(dataset.distributions[0]!.localPath).toBe('/rdf/catalog.ttl');
    expect(dataset.getDownloadDistributions()).toEqual(dataset.distributions);
  });

  it('rejects a file whose format it cannot tell', () => {
    expect(() => Dataset.localFile('/rdf/notes.txt')).toThrow(
      'Cannot tell the RDF format of “/rdf/notes.txt”',
    );
  });
});
