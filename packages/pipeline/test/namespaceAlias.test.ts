import { aliasVariants, canonicalizeIri } from '../src/namespaceAlias.js';
import type { NamespaceAlias } from '../src/namespaceAlias.js';
import { describe, it, expect } from 'vitest';

const schemaOrgAlias: NamespaceAlias = {
  canonical: 'https://schema.org/',
  alias: 'http://schema.org/',
};

describe('canonicalizeIri', () => {
  it('rewrites an alias-namespace IRI to the canonical namespace', () => {
    expect(
      canonicalizeIri('http://schema.org/CreativeWork', [schemaOrgAlias]),
    ).toBe('https://schema.org/CreativeWork');
  });

  it('keeps canonical-namespace IRIs unchanged', () => {
    expect(
      canonicalizeIri('https://schema.org/CreativeWork', [schemaOrgAlias]),
    ).toBe('https://schema.org/CreativeWork');
  });

  it('keeps IRIs outside every alias namespace unchanged', () => {
    expect(canonicalizeIri('http://example.org/Thing', [schemaOrgAlias])).toBe(
      'http://example.org/Thing',
    );
  });
});

describe('aliasVariants', () => {
  it('returns the alias variant for a canonical-namespace IRI', () => {
    expect(
      aliasVariants('https://schema.org/CreativeWork', [schemaOrgAlias]),
    ).toEqual([
      'https://schema.org/CreativeWork',
      'http://schema.org/CreativeWork',
    ]);
  });

  it('returns the canonical variant for an alias-namespace IRI', () => {
    expect(
      aliasVariants('http://schema.org/CreativeWork', [schemaOrgAlias]),
    ).toEqual([
      'http://schema.org/CreativeWork',
      'https://schema.org/CreativeWork',
    ]);
  });

  it('returns only the IRI itself outside every alias namespace', () => {
    expect(aliasVariants('http://example.org/Thing', [schemaOrgAlias])).toEqual(
      ['http://example.org/Thing'],
    );
  });
});
