import { describe, it, expect } from 'vitest';
import { Store } from 'n3';
import { Distribution } from '@lde/dataset';
import { ImportFailed } from '@lde/sparql-importer';
import {
  probeResultsToQuads,
  NetworkError,
  SparqlProbeResult,
  DataDumpProbeResult,
} from '../../src/distribution/index.js';
import { assertNoBlankNodes } from '../../src/index.js';

const SCHEMA = 'https://schema.org/';
const VOID = 'http://rdfs.org/ns/void#';
const RDF = 'http://www.w3.org/1999/02/22-rdf-syntax-ns#';
const XSD = 'http://www.w3.org/2001/XMLSchema#';

async function collect(
  quads: AsyncIterable<import('n3').Quad>,
): Promise<Store> {
  const store = new Store();
  for await (const quad of quads) {
    store.addQuad(quad);
  }
  return store;
}

function sparqlResponse(overrides?: ResponseInit): Response {
  return new Response('{}', {
    status: 200,
    headers: { 'Content-Type': 'application/sparql-results+json' },
    ...overrides,
  });
}

describe('probeResultsToQuads', () => {
  it('yields schema:error literal for a network error', async () => {
    const results = [
      new NetworkError('http://example.org/sparql', 'ECONNREFUSED', 0),
    ];
    const store = await collect(
      probeResultsToQuads(results, 'http://example.org/dataset'),
    );

    const errors = store.getQuads(null, `${SCHEMA}error`, null, null);
    expect(errors).toHaveLength(1);
    expect(errors[0].object.value).toBe('ECONNREFUSED');
  });

  it('emits no blank nodes (they fuse across datasets in a cat-built index, #474)', async () => {
    const results = [
      new NetworkError('http://example.org/sparql', 'ECONNREFUSED', 0),
    ];
    const store = await collect(
      probeResultsToQuads(results, 'http://example.org/dataset'),
    );
    assertNoBlankNodes(store.getQuads(null, null, null, null));
  });

  it('yields schema:error with status URI for HTTP error', async () => {
    const result = new SparqlProbeResult(
      'http://example.org/sparql',
      new Response('', { status: 404, statusText: 'Not Found' }),
      0,
      'application/sparql-results+json',
    );
    const store = await collect(
      probeResultsToQuads([result], 'http://example.org/dataset'),
    );

    const errors = store.getQuads(null, `${SCHEMA}error`, null, null);
    expect(errors).toHaveLength(1);
    expect(errors[0].object.value).toBe(
      'https://www.w3.org/2011/http-statusCodes#NotFound',
    );
  });

  it('yields void:sparqlEndpoint and action triples for successful SPARQL probe', async () => {
    const result = new SparqlProbeResult(
      'http://example.org/sparql',
      sparqlResponse(),
      0,
      'application/sparql-results+json',
    );
    const store = await collect(
      probeResultsToQuads([result], 'http://example.org/dataset'),
    );

    // Action type
    const actions = store.getQuads(null, `${RDF}type`, `${SCHEMA}Action`, null);
    expect(actions).toHaveLength(1);

    // Target
    const targets = store.getQuads(null, `${SCHEMA}target`, null, null);
    expect(targets).toHaveLength(1);
    expect(targets[0].object.value).toBe('http://example.org/sparql');

    // Result
    const results = store.getQuads(null, `${SCHEMA}result`, null, null);
    expect(results).toHaveLength(1);

    // void:sparqlEndpoint
    const endpoints = store.getQuads(
      'http://example.org/dataset',
      `${VOID}sparqlEndpoint`,
      null,
      null,
    );
    expect(endpoints).toHaveLength(1);
    expect(endpoints[0].object.value).toBe('http://example.org/sparql');
  });

  it('yields void:dataDump with metadata for successful data dump probe', async () => {
    const result = new DataDumpProbeResult(
      'http://example.org/data.nt',
      new Response('', {
        status: 200,
        headers: {
          'Content-Type': 'application/n-triples',
          'Content-Length': '1000',
          'Last-Modified': 'Wed, 01 Jan 2025 00:00:00 GMT',
        },
      }),
      0,
    );
    const store = await collect(
      probeResultsToQuads([result], 'http://example.org/dataset'),
    );

    // void:dataDump
    const dumps = store.getQuads(
      'http://example.org/dataset',
      `${VOID}dataDump`,
      null,
      null,
    );
    expect(dumps).toHaveLength(1);
    expect(dumps[0].object.value).toBe('http://example.org/data.nt');

    // contentSize
    const sizes = store.getQuads(
      'http://example.org/data.nt',
      `${SCHEMA}contentSize`,
      null,
      null,
    );
    expect(sizes).toHaveLength(1);
    expect(sizes[0].object.value).toBe('1000');

    // encodingFormat
    const formats = store.getQuads(
      'http://example.org/data.nt',
      `${SCHEMA}encodingFormat`,
      null,
      null,
    );
    expect(formats).toHaveLength(1);
    expect(formats[0].object.value).toBe('application/n-triples');

    // dateModified
    const dates = store.getQuads(
      'http://example.org/data.nt',
      `${SCHEMA}dateModified`,
      null,
      null,
    );
    expect(dates).toHaveLength(1);
    expect(
      'datatype' in dates[0].object && dates[0].object.datatype.value,
    ).toBe(`${XSD}dateTime`);
  });

  it('yields quads for multiple probe results', async () => {
    const results = [
      new SparqlProbeResult(
        'http://example.org/sparql',
        sparqlResponse(),
        0,
        'application/sparql-results+json',
      ),
      new NetworkError('http://example.org/other', 'timeout', 0),
    ];
    const store = await collect(
      probeResultsToQuads(results, 'http://example.org/dataset'),
    );

    const actions = store.getQuads(null, `${RDF}type`, `${SCHEMA}Action`, null);
    expect(actions).toHaveLength(2);
  });

  it('attaches import error to the correct action node', async () => {
    const distribution = new Distribution(
      new URL('http://example.org/data.nt'),
      'application/n-triples',
    );
    const probeResult = new DataDumpProbeResult(
      'http://example.org/data.nt',
      new Response('', {
        status: 200,
        headers: { 'Content-Length': '1000' },
      }),
      0,
    );
    const importError = new ImportFailed(distribution, 'Parse error');

    const store = await collect(
      probeResultsToQuads(
        [probeResult],
        'http://example.org/dataset',
        importError,
      ),
    );

    // The import error should be on the same action node as the action target
    const targets = store.getQuads(
      null,
      `${SCHEMA}target`,
      'http://example.org/data.nt',
      null,
    );
    expect(targets).toHaveLength(1);
    const actionNode = targets[0].subject;

    const errors = store.getQuads(actionNode, `${SCHEMA}error`, null, null);
    expect(errors).toHaveLength(1);
    expect(errors[0].object.value).toBe('Parse error');
  });

  it('yields schema:error literal for data dump with failure reason', async () => {
    const result = new DataDumpProbeResult(
      'http://example.org/data.ttl',
      new Response('', {
        status: 200,
        headers: { 'Content-Type': 'text/turtle' },
      }),
      0,
      'Distribution is empty',
    );
    const store = await collect(
      probeResultsToQuads([result], 'http://example.org/dataset'),
    );

    const errors = store.getQuads(null, `${SCHEMA}error`, null, null);
    expect(errors).toHaveLength(1);
    expect(errors[0].object.value).toBe('Distribution is empty');

    // Should not emit void:dataDump since it's a failure.
    const dumps = store.getQuads(null, `${VOID}dataDump`, null, null);
    expect(dumps).toHaveLength(0);
  });

  it('mints stable, distinct action IRIs per URL, not blank nodes (issue #474)', async () => {
    const results = [
      new SparqlProbeResult(
        'http://example.org/sparql',
        sparqlResponse(),
        0,
        'application/sparql-results+json',
      ),
      new NetworkError('http://example.org/other', 'timeout', 0),
    ];

    const actionSubjects = async () => {
      const store = await collect(
        probeResultsToQuads(results, 'http://example.org/dataset'),
      );
      return store
        .getQuads(null, `${RDF}type`, `${SCHEMA}Action`, null)
        .map((q) => q.subject);
    };

    const subjects = await actionSubjects();
    // Two URLs -> two distinct action nodes, each an IRI.
    expect(subjects).toHaveLength(2);
    expect(subjects.every((s) => s.termType === 'NamedNode')).toBe(true);
    expect(new Set(subjects.map((s) => s.value)).size).toBe(2);

    // Re-running yields the same IRIs (idempotent across runs).
    const rerun = await actionSubjects();
    expect(rerun.map((s) => s.value).sort()).toEqual(
      subjects.map((s) => s.value).sort(),
    );
  });

  it('yields nothing for empty probe results', async () => {
    const store = await collect(
      probeResultsToQuads([], 'http://example.org/dataset'),
    );

    expect(store.size).toBe(0);
  });
});
