import { resolveDistributions } from '../../src/distribution/index.js';
import {
  ResolvedDistribution,
  NoDistributionAvailable,
  ProbedDistributions,
  type DistributionResolver,
} from '../../src/distribution/index.js';
import { Dataset, Distribution } from '@lde/dataset';
import { ImportFailed } from '@lde/sparql-importer';
import {
  SparqlProbeResult,
  DataDumpProbeResult,
  NetworkError,
} from '@lde/distribution-probe';
import { describe, it, expect } from 'vitest';

async function collect<T>(iterable: AsyncIterable<T>): Promise<T[]> {
  const items: T[] = [];
  for await (const item of iterable) {
    items.push(item);
  }
  return items;
}

function mockResolver(
  result: ResolvedDistribution | NoDistributionAvailable,
): DistributionResolver {
  return {
    probe: async (dataset) =>
      new ProbedDistributions(dataset, result.probeResults, null),
    resolve: async () => result,
  };
}

describe('resolveDistributions', () => {
  it('returns resolved distribution and probe report quads', async () => {
    const distribution = Distribution.sparql(
      new URL('http://example.org/sparql'),
    );
    const probeResult = new SparqlProbeResult(
      'http://example.org/sparql',
      new Response('{}', {
        status: 200,
        headers: { 'Content-Type': 'application/sparql-results+json' },
      }),
      0,
      'application/sparql-results+json',
    );
    const dataset = new Dataset({
      iri: new URL('http://example.org/dataset'),
      distributions: [distribution],
    });
    const resolver = mockResolver(
      new ResolvedDistribution(distribution, [probeResult]),
    );

    const result = await resolveDistributions(dataset, resolver);

    expect(result.distribution).toBe(distribution);
    expect(result.probeResults).toEqual([probeResult]);
    const quads = await collect(result.quads);
    expect(quads.length).toBeGreaterThan(0);
  });

  it('returns null distribution and error quads on network error', async () => {
    const dataset = new Dataset({
      iri: new URL('http://example.org/dataset'),
      distributions: [
        Distribution.sparql(new URL('http://example.org/sparql')),
      ],
    });
    const networkError = new NetworkError(
      'http://example.org/sparql',
      'Connection refused',
      0,
    );
    const resolver = mockResolver(
      new NoDistributionAvailable(
        dataset,
        'No SPARQL endpoint or importable data dump available',
        [networkError],
      ),
    );

    const result = await resolveDistributions(dataset, resolver);

    expect(result.distribution).toBeNull();
    expect(result.probeResults).toEqual([networkError]);
    const quads = await collect(result.quads);
    expect(quads.length).toBeGreaterThan(0);
    const errorQuad = quads.find(
      (q) => q.predicate.value === 'https://schema.org/error',
    );
    expect(errorQuad).toBeDefined();
    expect(errorQuad!.object.value).toBe('Connection refused');
  });

  it('returns null distribution and import error quads when importer fails', async () => {
    const dataDumpDistribution = new Distribution(
      new URL('http://example.org/data.nt'),
      'application/n-triples',
    );
    const dataset = new Dataset({
      iri: new URL('http://example.org/dataset'),
      distributions: [dataDumpDistribution],
    });
    const probeResult = new DataDumpProbeResult(
      'http://example.org/data.nt',
      new Response('', {
        status: 200,
        headers: { 'Content-Length': '1000' },
      }),
      0,
    );
    const importFailed = new ImportFailed(dataDumpDistribution, 'Parse error');
    const resolver = mockResolver(
      new NoDistributionAvailable(
        dataset,
        'No SPARQL endpoint or importable data dump available',
        [probeResult],
        importFailed,
      ),
    );

    const result = await resolveDistributions(dataset, resolver);

    expect(result.distribution).toBeNull();
    expect(result.probeResults).toEqual([probeResult]);
    const quads = await collect(result.quads);
    expect(quads.length).toBeGreaterThan(0);
    const errorQuad = quads.find(
      (q) =>
        q.predicate.value === 'https://schema.org/error' &&
        q.object.value === 'Parse error',
    );
    expect(errorQuad).toBeDefined();
  });

  it('works with a custom DistributionResolver implementation', async () => {
    const distribution = Distribution.sparql(
      new URL('http://custom.org/sparql'),
    );
    const probeResult = new SparqlProbeResult(
      'http://custom.org/sparql',
      new Response('{}', {
        status: 200,
        headers: { 'Content-Type': 'application/sparql-results+json' },
      }),
      0,
      'application/sparql-results+json',
    );
    const dataset = new Dataset({
      iri: new URL('http://custom.org/dataset'),
      distributions: [distribution],
    });

    const customResolver: DistributionResolver = {
      async probe(dataset) {
        return new ProbedDistributions(dataset, [probeResult], {
          distribution,
          probeResult,
        });
      },
      async resolve() {
        return new ResolvedDistribution(distribution, [probeResult]);
      },
    };

    const result = await resolveDistributions(dataset, customResolver);

    expect(result.distribution).toBe(distribution);
    expect(result.probeResults).toHaveLength(1);
    const quads = await collect(result.quads);
    expect(quads.length).toBeGreaterThan(0);
  });
});
