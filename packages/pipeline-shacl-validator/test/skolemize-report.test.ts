import { describe, it, expect } from 'vitest';
import { DataFactory } from 'n3';
import type { Quad } from '@rdfjs/types';
import { skolemizeReport } from '../src/skolemize-report.js';

const { namedNode, blankNode, literal, quad } = DataFactory;

const DATASET = 'http://example.org/ds';
const RDF_TYPE = namedNode('http://www.w3.org/1999/02/22-rdf-syntax-ns#type');
const sh = (local: string) => namedNode(`http://www.w3.org/ns/shacl#${local}`);

// A minimal report — two batches restart their blank labels at the same `b1`/`b2`,
// just as shacl-engine does across separate validate() calls.
function reportAbout(focusNode: string): Quad[] {
  const report = blankNode('b1');
  const result = blankNode('b2');
  return [
    quad(report, RDF_TYPE, sh('ValidationReport')),
    quad(report, sh('result'), result),
    quad(result, RDF_TYPE, sh('ValidationResult')),
    quad(result, sh('focusNode'), namedNode(focusNode)),
    quad(result, sh('resultMessage'), literal('missing name')),
  ];
}

const resultIri = (quads: Quad[]) =>
  quads.find((quad) => quad.predicate.value === sh('result').value)?.object
    .value;

describe('skolemizeReport', () => {
  it('replaces every blank node with a dataset-scoped IRI', () => {
    const out = skolemizeReport(reportAbout('http://example.org/bob'), DATASET);

    const noBlankNodes = out.every((quad) =>
      [quad.subject, quad.object, quad.graph].every(
        (term) => term.termType !== 'BlankNode',
      ),
    );
    expect(noBlankNodes).toBe(true);
    expect(resultIri(out)).toMatch(
      new RegExp(`^${DATASET}/\\.well-known/shacl#[0-9a-f]+-`),
    );
  });

  it('is a pure function of the report (same input → same IRIs)', () => {
    const first = skolemizeReport(
      reportAbout('http://example.org/bob'),
      DATASET,
    );
    const second = skolemizeReport(
      reportAbout('http://example.org/bob'),
      DATASET,
    );

    expect(resultIri(first)).toBe(resultIri(second));
  });

  it('does not fuse batches that reuse blank labels for different violations', () => {
    const bob = skolemizeReport(reportAbout('http://example.org/bob'), DATASET);
    const carol = skolemizeReport(
      reportAbout('http://example.org/carol'),
      DATASET,
    );

    // Both reports label their result `b2`; the per-batch hash keeps the minted
    // IRIs distinct so they cannot collapse in a shared validation graph.
    expect(resultIri(bob)).not.toBe(resultIri(carol));
  });

  it('scopes IRIs by dataset so results do not collide across datasets', () => {
    const here = skolemizeReport(
      reportAbout('http://example.org/bob'),
      DATASET,
    );
    const there = skolemizeReport(
      reportAbout('http://example.org/bob'),
      'http://example.org/other',
    );

    expect(resultIri(here)).not.toBe(resultIri(there));
  });
});
