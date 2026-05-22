import { describe, it, expect } from 'vitest';
import { join } from 'node:path';
import { DataFactory } from 'n3';
import type { Quad } from '@rdfjs/types';
import type { Dataset } from '@lde/dataset';
import type { Validator } from '@lde/pipeline';
import {
  buildSampleQuery,
  buildSubjectSelectorQuery,
  shaclSampleStages,
  wrapValidatorWithAliasNormalization,
} from '../src/sampleStages.js';
import type { TargetShape } from '../src/pathExtractor.js';

const { namedNode, quad, literal, defaultGraph } = DataFactory;
const shapesFile = join(__dirname, 'fixtures', 'schema-profile.ttl');

describe('buildSampleQuery', () => {
  const shape: TargetShape = {
    targetClass: namedNode('https://schema.org/CreativeWork'),
    pathChains: [
      [namedNode('https://schema.org/creator')],
      [
        namedNode('https://schema.org/creator'),
        namedNode('https://schema.org/birthPlace'),
      ],
    ],
  };

  it('contains no inner SELECT or LIMIT — sample selection is the ItemSelector’s job', () => {
    const query = buildSampleQuery(shape);
    expect(query).not.toMatch(/\bSELECT\b/);
    expect(query).not.toMatch(/\bLIMIT\b/);
  });

  it('emits one UNION branch per path chain using SPARQL property-paths', () => {
    const query = buildSampleQuery(shape);
    expect(query).toContain('<https://schema.org/creator> ?neighbour');
    expect(query).toContain(
      '<https://schema.org/creator>/<https://schema.org/birthPlace> ?neighbour',
    );
  });

  it('emits CONSTRUCT for the sampled subject and its neighbours', () => {
    const query = buildSampleQuery(shape);
    expect(query).toMatch(/^CONSTRUCT \{\s*\?s \?p \?o \./);
    expect(query).toContain('?neighbour ?np ?nv');
  });
});

describe('buildSubjectSelectorQuery', () => {
  const targetClass = namedNode('https://schema.org/CreativeWork');
  const schemaOrgAlias = {
    canonical: 'https://schema.org/',
    alias: 'http://schema.org/',
  };

  it('produces a SELECT DISTINCT ?s without LIMIT (cap is applied by SparqlItemSelector.maxResults)', () => {
    const query = buildSubjectSelectorQuery({ targetClass });
    expect(query).toMatch(/SELECT DISTINCT \?s/);
    expect(query).not.toMatch(/\bLIMIT\b/);
  });

  it('emits the plain bound type pattern by default (no namespace aliases)', () => {
    const query = buildSubjectSelectorQuery({ targetClass });
    expect(query).toContain('?s a <https://schema.org/CreativeWork> .');
    expect(query).not.toMatch(/FILTER\(\?type IN/);
  });

  it('broadens to FILTER IN when a configured alias namespace matches the canonical target class IRI', () => {
    const query = buildSubjectSelectorQuery({
      targetClass,
      namespaceAliases: [schemaOrgAlias],
    });
    expect(query).toContain('?s a ?type');
    expect(query).toContain(
      'FILTER(?type IN (<https://schema.org/CreativeWork>, <http://schema.org/CreativeWork>))',
    );
  });

  it('also broadens when the target class IRI itself uses the alias namespace', () => {
    const query = buildSubjectSelectorQuery({
      targetClass: namedNode('http://schema.org/CreativeWork'),
      namespaceAliases: [schemaOrgAlias],
    });
    expect(query).toContain(
      'FILTER(?type IN (<http://schema.org/CreativeWork>, <https://schema.org/CreativeWork>))',
    );
  });

  it('leaves a target class outside every configured alias namespace as a plain bound pattern', () => {
    const query = buildSubjectSelectorQuery({
      targetClass: namedNode('https://example.org/vocab/Widget'),
      namespaceAliases: [schemaOrgAlias],
    });
    expect(query).toContain('?s a <https://example.org/vocab/Widget> .');
    expect(query).not.toMatch(/FILTER\(\?type IN/);
  });

  it('inlines a subjectFilter when provided', () => {
    const query = buildSubjectSelectorQuery({
      targetClass,
      subjectFilter: '?s <https://example.org/inDataset> <urn:d> .',
    });
    expect(query).toContain('?s <https://example.org/inDataset> <urn:d> .');
  });

  it('emits a FROM clause when the distribution has a named graph', () => {
    const query = buildSubjectSelectorQuery({
      targetClass,
      namedGraph: 'https://example.org/graph',
    });
    expect(query).toContain('FROM <https://example.org/graph>');
  });
});

describe('wrapValidatorWithAliasNormalization', () => {
  const aliases = [
    { canonical: 'https://schema.org/', alias: 'http://schema.org/' },
  ];

  function captureValidator(): {
    validator: Validator;
    seen: Quad[][];
  } {
    const seen: Quad[][] = [];
    const validator: Validator = {
      async validate(quads) {
        seen.push(quads);
        return { conforms: true, violations: 0 };
      },
      async report() {
        return { conforms: true, violations: 0, quadsValidated: 0 };
      },
    };
    return { validator, seen };
  }

  it('rewrites alias-namespace IRIs in subject, predicate, and object positions', async () => {
    const { validator, seen } = captureValidator();
    const wrapped = wrapValidatorWithAliasNormalization(validator, aliases);
    const input = [
      quad(
        namedNode('https://example.org/work/1'),
        namedNode('http://www.w3.org/1999/02/22-rdf-syntax-ns#type'),
        namedNode('http://schema.org/CreativeWork'),
        defaultGraph(),
      ),
      quad(
        namedNode('https://example.org/work/1'),
        namedNode('http://schema.org/creator'),
        namedNode('http://schema.org/Person/some-id'),
        defaultGraph(),
      ),
    ];
    await wrapped.validate(input, {} as Dataset);
    expect(seen).toHaveLength(1);
    const handed = seen[0] ?? [];
    expect(handed.map((q) => q.predicate.value)).toEqual([
      'http://www.w3.org/1999/02/22-rdf-syntax-ns#type',
      'https://schema.org/creator',
    ]);
    expect(handed.map((q) => q.object.value)).toEqual([
      'https://schema.org/CreativeWork',
      'https://schema.org/Person/some-id',
    ]);
  });

  it('leaves quads that contain no alias IRI unchanged (same reference)', async () => {
    const { validator, seen } = captureValidator();
    const wrapped = wrapValidatorWithAliasNormalization(validator, aliases);
    const untouched = quad(
      namedNode('https://example.org/work/1'),
      namedNode('https://schema.org/name'),
      literal('Untouched'),
      defaultGraph(),
    );
    await wrapped.validate([untouched], {} as Dataset);
    expect(seen[0]?.[0]).toBe(untouched);
  });

  it('returns the inner validator unchanged when there are no aliases', () => {
    const { validator } = captureValidator();
    expect(wrapValidatorWithAliasNormalization(validator, [])).toBe(validator);
  });

  it('delegates report() straight through to the inner validator', async () => {
    const reports: Dataset[] = [];
    const inner: Validator = {
      async validate() {
        return { conforms: true, violations: 0 };
      },
      async report(dataset) {
        reports.push(dataset);
        return { conforms: true, violations: 7, quadsValidated: 42 };
      },
    };
    const wrapped = wrapValidatorWithAliasNormalization(inner, aliases);
    const dataset = { iri: 'urn:test' } as unknown as Dataset;
    const result = await wrapped.report(dataset);
    expect(reports[0]).toBe(dataset);
    expect(result).toMatchObject({ violations: 7, quadsValidated: 42 });
  });
});

describe('shaclSampleStages', () => {
  it('returns one Stage per sh:targetClass in the SHACL', async () => {
    const stages = await shaclSampleStages({ shapesFile });
    const names = stages.map((s) => s.name).sort();
    expect(names).toEqual([
      'shacl-sample-CreativeWork',
      'shacl-sample-Organization',
      'shacl-sample-Person',
      'shacl-sample-Place',
    ]);
  });

  it('does not attach a validator slot when no validator is passed', async () => {
    const stages = await shaclSampleStages({ shapesFile });
    for (const stage of stages) {
      expect(stage.validator).toBeUndefined();
    }
  });

  it('wraps the provided validator so configured alias IRIs are rewritten before delegation', async () => {
    const seen: Quad[][] = [];
    const inner: Validator = {
      async validate(quads) {
        seen.push(quads);
        return { conforms: true, violations: 0 };
      },
      async report() {
        return { conforms: true, violations: 0, quadsValidated: 0 };
      },
    };
    const [firstStage] = await shaclSampleStages({
      shapesFile,
      validator: inner,
      namespaceAliases: [
        { canonical: 'https://schema.org/', alias: 'http://schema.org/' },
      ],
    });
    const wrapped = firstStage?.validator;
    expect(wrapped).toBeDefined();
    expect(wrapped).not.toBe(inner);
    await wrapped?.validate(
      [
        quad(
          namedNode('https://example.org/work/1'),
          namedNode('http://schema.org/creator'),
          namedNode('https://example.org/person/2'),
          defaultGraph(),
        ),
      ],
      {} as Dataset,
    );
    expect(seen[0]?.[0]?.predicate.value).toBe('https://schema.org/creator');
  });

  it('passes the validator through unchanged when no namespaceAliases are configured (the default)', async () => {
    const inner: Validator = {
      async validate() {
        return { conforms: true, violations: 0 };
      },
      async report() {
        return { conforms: true, violations: 0, quadsValidated: 0 };
      },
    };
    const stages = await shaclSampleStages({
      shapesFile,
      validator: inner,
    });
    for (const stage of stages) {
      expect(stage.validator).toBe(inner);
    }
  });
});
