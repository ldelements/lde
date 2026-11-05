import { mintPartitionIri, substituteMintMarkers } from '../src/index.js';
import { describe, it, expect } from 'vitest';

const DATASET = 'http://example.org/dataset';

describe('mintPartitionIri', () => {
  it('mints a class partition matching the SPARQL MD5 from issue #334', () => {
    // MD5("https://schema.org/CreativeWork") verified against the live endpoint.
    expect(
      mintPartitionIri(DATASET, 'class', ['https://schema.org/CreativeWork']),
    ).toBe(
      `${DATASET}/.well-known/void#class-abb86c011bcc584d50e50bf8f079120a`,
    );
  });

  it('hashes the concatenation of a multi-component key', () => {
    const property = mintPartitionIri(DATASET, 'class-property', [
      'https://schema.org/CreativeWork',
      'https://schema.org/name',
    ]);
    expect(property).toMatch(
      /^http:\/\/example\.org\/dataset\/\.well-known\/void#class-property-[0-9a-f]{32}$/,
    );
  });
});

describe('substituteMintMarkers', () => {
  it('expands a #mint:<kind># marker to the equivalent SPARQL value expression', () => {
    expect(substituteMintMarkers('BIND(#mint:class# AS ?classPartition)')).toBe(
      'BIND(URI(CONCAT(STR(?dataset), "/.well-known/void#class-", MD5(STR(?class)))) AS ?classPartition)',
    );
  });

  it('CONCATs the components for a multi-component kind', () => {
    expect(substituteMintMarkers('#mint:datatype#')).toBe(
      'URI(CONCAT(STR(?dataset), "/.well-known/void#datatype-", MD5(CONCAT(STR(?class), STR(?p), STR(?dt)))))',
    );
  });

  it('hashes the language tag without STR()', () => {
    expect(substituteMintMarkers('#mint:language#')).toContain(
      'MD5(CONCAT(STR(?class), STR(?p), ?lang))',
    );
  });

  it('leaves text without markers unchanged', () => {
    expect(substituteMintMarkers('SELECT * WHERE { ?s ?p ?o }')).toBe(
      'SELECT * WHERE { ?s ?p ?o }',
    );
  });

  it('throws on an unknown partition kind', () => {
    expect(() => substituteMintMarkers('#mint:bogus#')).toThrow(
      'Unknown partition kind',
    );
  });
});
