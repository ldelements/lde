import {
  canonicalizeClassBindings,
  substituteNormalizationMarkers,
  withAliasVariantBindings,
} from '../src/index.js';
import type { NamespaceAlias } from '../src/index.js';
import type { Reader, VariableBindings } from '@lde/pipeline';
import { Dataset, Distribution } from '@lde/dataset';
import type { Quad } from '@rdfjs/types';
import { DataFactory } from 'n3';
import { describe, it, expect, vi } from 'vitest';

const { namedNode } = DataFactory;

async function* noQuads() {
  yield* [] as Quad[];
}

const schemaOrgAlias: NamespaceAlias = {
  canonical: 'https://schema.org/',
  alias: 'http://schema.org/',
};

describe('substituteNormalizationMarkers', () => {
  it('expands a marker to the bare variable without aliases', () => {
    expect(
      substituteNormalizationMarkers('BIND(#normalized:rawType# AS ?type)', []),
    ).toBe('BIND(?rawType AS ?type)');
  });

  it('expands a marker to a rewrite expression per alias', () => {
    expect(
      substituteNormalizationMarkers('BIND(#normalized:rawType# AS ?type)', [
        schemaOrgAlias,
      ]),
    ).toBe(
      'BIND(IF(STRSTARTS(STR(?rawType), "http://schema.org/"), IRI(CONCAT("https://schema.org/", STRAFTER(STR(?rawType), "http://schema.org/"))), ?rawType) AS ?type)',
    );
  });

  it('replaces every marker in the query', () => {
    const substituted = substituteNormalizationMarkers(
      'BIND(#normalized:rawClass# AS ?class) BIND(#normalized:rawProperty# AS ?p)',
      [],
    );
    expect(substituted).toBe(
      'BIND(?rawClass AS ?class) BIND(?rawProperty AS ?p)',
    );
  });

  it('rejects namespaces that cannot be interpolated safely', () => {
    expect(() =>
      substituteNormalizationMarkers('#normalized:rawType#', [
        { canonical: 'https://schema.org/', alias: 'http://schema.org/"' },
      ]),
    ).toThrow('unsafe characters');
  });
});

describe('canonicalizeClassBindings', () => {
  it('canonicalizes alias-namespace classes and deduplicates variants', async () => {
    const rows = (async function* () {
      yield { class: namedNode('http://schema.org/CreativeWork') };
      yield { class: namedNode('https://schema.org/CreativeWork') };
      yield { class: namedNode('http://example.org/Other') };
    })();

    const result: VariableBindings[] = [];
    for await (const row of canonicalizeClassBindings(rows, [schemaOrgAlias])) {
      result.push(row);
    }

    expect(result).toEqual([
      { class: namedNode('https://schema.org/CreativeWork') },
      { class: namedNode('http://example.org/Other') },
    ]);
  });
});

describe('withAliasVariantBindings', () => {
  const dataset = new Dataset({
    iri: new URL('http://example.org/dataset'),
    distributions: [],
  });
  const distribution = Distribution.sparql(
    new URL('http://example.org/sparql'),
  );

  it('expands each canonical class to one class binding per variant', async () => {
    const inner: Reader = {
      read: vi.fn(async () => noQuads()),
    };
    const reader = withAliasVariantBindings(inner, [schemaOrgAlias]);

    await reader.read(dataset, distribution, {
      bindings: [
        { class: namedNode('https://schema.org/CreativeWork') },
        { class: namedNode('http://example.org/Other') },
      ],
    });

    expect(inner.read).toHaveBeenCalledWith(dataset, distribution, {
      bindings: [
        { class: namedNode('https://schema.org/CreativeWork') },
        { class: namedNode('http://schema.org/CreativeWork') },
        { class: namedNode('http://example.org/Other') },
      ],
    });
  });

  it('passes through calls without bindings', async () => {
    const inner: Reader = {
      read: vi.fn(async () => noQuads()),
    };
    const reader = withAliasVariantBindings(inner, [schemaOrgAlias]);

    await reader.read(dataset, distribution);

    expect(inner.read).toHaveBeenCalledWith(dataset, distribution, {
      bindings: undefined,
    });
  });
});
