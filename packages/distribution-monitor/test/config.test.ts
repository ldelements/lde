import { describe, it, expect } from 'vitest';
import { Distribution } from '@lde/dataset';
import { defineConfig, normalizeConfig } from '../src/config.js';

describe('defineConfig', () => {
  it('returns the config as-is', () => {
    const config = {
      databaseUrl: 'postgres://localhost/test',
      intervalSeconds: 60,
      monitors: [
        {
          identifier: 'test',
          distribution: {
            accessUrl: 'https://example.org/sparql',
            conformsTo: 'https://www.w3.org/TR/sparql11-protocol/',
          },
          sparqlQuery: 'ASK { ?s ?p ?o }',
        },
      ],
    };

    expect(defineConfig(config)).toEqual(config);
  });
});

describe('normalizeConfig', () => {
  it('constructs a Distribution from string URLs', () => {
    const raw = {
      databaseUrl: 'postgres://localhost/test',
      intervalSeconds: 300,
      monitors: [
        {
          identifier: 'dbpedia',
          distribution: {
            accessUrl: 'https://example.org/sparql',
            conformsTo: 'https://www.w3.org/TR/sparql11-protocol/',
          },
          sparqlQuery: 'ASK { ?s ?p ?o }',
        },
      ],
    };

    const normalized = normalizeConfig(raw);

    expect(normalized.databaseUrl).toBe('postgres://localhost/test');
    expect(normalized.intervalSeconds).toBe(300);
    expect(normalized.monitors[0].identifier).toBe('dbpedia');
    expect(normalized.monitors[0].distribution).toBeInstanceOf(Distribution);
    expect(normalized.monitors[0].distribution.accessUrl.href).toBe(
      'https://example.org/sparql',
    );
    expect(normalized.monitors[0].distribution.isSparql()).toBe(true);
    expect(normalized.monitors[0].sparqlQuery).toBe('ASK { ?s ?p ?o }');
  });

  it('preserves URL objects', () => {
    const accessUrl = new URL('https://example.org/data.nt');
    const raw = {
      monitors: [
        {
          identifier: 'dump',
          distribution: {
            accessUrl,
            mediaType: 'application/n-triples',
          },
        },
      ],
    };

    const normalized = normalizeConfig(raw);

    expect(normalized.monitors[0].distribution.accessUrl).toBe(accessUrl);
    expect(normalized.monitors[0].distribution.mimeType).toBe(
      'application/n-triples',
    );
    expect(normalized.monitors[0].distribution.isSparql()).toBe(false);
  });

  it('forwards timeoutMs', () => {
    const normalized = normalizeConfig({
      timeoutMs: 10_000,
      monitors: [
        {
          identifier: 'x',
          distribution: { accessUrl: 'https://example.org/data' },
        },
      ],
    });

    expect(normalized.timeoutMs).toBe(10_000);
  });
});
