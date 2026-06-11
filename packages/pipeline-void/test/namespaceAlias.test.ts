import { applyNamespaceAliases, type NamespaceAlias } from '../src/index.js';
import { Parser } from '@traqula/parser-sparql-1-1';
import { readFile, readdir } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it, expect } from 'vitest';

const schemaOrg: NamespaceAlias[] = [
  { canonical: 'https://schema.org/', alias: 'http://schema.org/' },
];

const queriesDir = resolve(
  dirname(fileURLToPath(import.meta.url)),
  '..',
  'queries',
);

describe('applyNamespaceAliases', () => {
  it('leaves placeholders as a plain type triple when no aliases are given', () => {
    expect(applyNamespaceAliases('#typePattern(?s, ?type)#', [])).toBe(
      '?s a ?type .',
    );
    expect(applyNamespaceAliases('#typePatternFiltered(?s, ?class)#', [])).toBe(
      '?s a ?class .',
    );
  });

  it('binds the canonical type for a grouped variable', () => {
    const result = applyNamespaceAliases('#typePattern(?s, ?type)#', schemaOrg);
    expect(result).toContain('?s a ?typeRaw .');
    expect(result).toContain('STRSTARTS(STR(?typeRaw), "http://schema.org/")');
    expect(result).toContain('"https://schema.org/"');
    expect(result).toContain('AS ?type');
  });

  it('filters by canonical type for an injected variable', () => {
    const result = applyNamespaceAliases(
      '#typePatternFiltered(?s, ?class)#',
      schemaOrg,
    );
    // The injected ?class must not be reassigned with BIND, so the canonical
    // form is bound to a helper and compared with FILTER.
    expect(result).toContain('?s a ?classActual .');
    expect(result).toContain('AS ?classCanonical');
    expect(result).toContain('FILTER(?classCanonical = ?class)');
    expect(result).not.toContain('AS ?class)');
  });

  it('nests aliases so the first matching prefix wins', () => {
    const result = applyNamespaceAliases('#typePattern(?o, ?objectClass)#', [
      { canonical: 'https://schema.org/', alias: 'http://schema.org/' },
      { canonical: 'https://example.org/', alias: 'http://example.org/' },
    ]);
    expect(result).toContain('http://schema.org/');
    expect(result).toContain('http://example.org/');
  });

  it('rejects namespaces that could break out of a SPARQL literal', () => {
    expect(() =>
      applyNamespaceAliases('#typePattern(?s, ?type)#', [
        { canonical: 'https://schema.org/', alias: 'http://schema.org/"evil' },
      ]),
    ).toThrow(/unsafe/);
  });
});

describe('canonicalised queries parse as valid SPARQL', () => {
  const parser = new Parser();

  // Substitute the runtime placeholders the executor fills in, plus a VALUES
  // clause mimicking the per-class binding injection, so the parsed query
  // matches what actually runs against the endpoint.
  const prepare = (query: string): string =>
    query
      .replaceAll(
        '#subjectFilter#',
        'VALUES ?class { <https://schema.org/Thing> }',
      )
      .replaceAll('?dataset', '<https://example.org/dataset>');

  it('parses every class-keyed query with schema.org aliases applied', async () => {
    const files = (await readdir(queriesDir)).filter((file) =>
      file.endsWith('.rq'),
    );
    for (const file of files) {
      const raw = await readFile(resolve(queriesDir, file), 'utf-8');
      const canonicalised = applyNamespaceAliases(raw, schemaOrg);
      expect(
        () => parser.parse(prepare(canonicalised)),
        `${file} should parse`,
      ).not.toThrow();
    }
  });
});
