import {
  SparqlDistributionResolver,
  ResolvedDistribution,
  NoDistributionAvailable,
  SparqlProbeResult,
  DataDumpProbeResult,
  NetworkError,
} from '../../src/distribution/index.js';
import { Dataset, Distribution } from '@lde/dataset';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

/** Run both phases, as the pipeline does. */
async function resolve(resolver: SparqlDistributionResolver, dataset: Dataset) {
  return resolver.resolve(await resolver.probe(dataset));
}

describe('SparqlDistributionResolver', () => {
  beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn());
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('resolves to a valid SPARQL endpoint', async () => {
    vi.mocked(fetch).mockResolvedValue(
      new Response('{"results": {"bindings": []}}', {
        status: 200,
        headers: { 'Content-Type': 'application/sparql-results+json' },
      }),
    );

    const resolver = new SparqlDistributionResolver();
    const distribution = Distribution.sparql(
      new URL('http://example.org/sparql'),
    );
    const dataset = new Dataset({
      iri: new URL('http://example.org/dataset'),
      distributions: [distribution],
    });

    const result = await resolve(resolver, dataset);

    expect(result).toBeInstanceOf(ResolvedDistribution);
    const resolved = result as ResolvedDistribution;
    expect(resolved.distribution).toBe(distribution);
    expect(resolved.probeResults).toHaveLength(1);
    expect(resolved.probeResults[0]).toBeInstanceOf(SparqlProbeResult);
  });

  it('returns NoDistributionAvailable when no endpoint', async () => {
    vi.mocked(fetch).mockResolvedValue(
      new Response('', {
        status: 200,
        headers: { 'Content-Length': '1000' },
      }),
    );

    const resolver = new SparqlDistributionResolver();
    const dataset = new Dataset({
      iri: new URL('http://example.org/dataset'),
      distributions: [
        new Distribution(
          new URL('http://example.org/data.nt'),
          'application/n-triples',
        ),
      ],
    });

    const result = await resolve(resolver, dataset);

    expect(result).toBeInstanceOf(NoDistributionAvailable);
    const noDistribution = result as NoDistributionAvailable;
    expect(noDistribution.probeResults).toHaveLength(1);
    expect(noDistribution.probeResults[0]).toBeInstanceOf(DataDumpProbeResult);
    expect(noDistribution.importFailed).toBeUndefined();
  });

  it('returns NoDistributionAvailable on network error during probe', async () => {
    vi.mocked(fetch).mockRejectedValue(new Error('Connection refused'));

    const resolver = new SparqlDistributionResolver();
    const dataset = new Dataset({
      iri: new URL('http://example.org/dataset'),
      distributions: [
        Distribution.sparql(new URL('http://example.org/sparql')),
      ],
    });

    const result = await resolve(resolver, dataset);

    expect(result).toBeInstanceOf(NoDistributionAvailable);
    const noDistribution = result as NoDistributionAvailable;
    expect(noDistribution.probeResults).toHaveLength(1);
    expect(noDistribution.probeResults[0]).toBeInstanceOf(NetworkError);
  });

  it('does not mutate dataset.distributions', async () => {
    vi.mocked(fetch).mockResolvedValue(
      new Response('{"results": {"bindings": []}}', {
        status: 200,
        headers: { 'Content-Type': 'application/sparql-results+json' },
      }),
    );

    const resolver = new SparqlDistributionResolver();
    const dataset = new Dataset({
      iri: new URL('http://example.org/dataset'),
      distributions: [
        Distribution.sparql(new URL('http://example.org/sparql')),
      ],
    });

    const originalLength = dataset.distributions.length;

    await resolve(resolver, dataset);

    expect(dataset.distributions.length).toBe(originalLength);
  });
});
