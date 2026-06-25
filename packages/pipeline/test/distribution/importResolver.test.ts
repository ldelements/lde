import {
  ImportResolver,
  ResolvedDistribution,
  NoDistributionAvailable,
  ProbedDistributions,
  DataDumpProbeResult,
  SparqlProbeResult,
  type DistributionResolver,
  type ProbeResultType,
  type ResolveCallbacks,
} from '../../src/distribution/index.js';
import { Dataset, Distribution } from '@lde/dataset';
import {
  ImportSuccessful,
  ImportFailed,
  NotSupported,
} from '@lde/sparql-importer';
import type { SparqlServer } from '@lde/sparql-server';
import { describe, it, expect, vi } from 'vitest';

const SPARQL_URL = 'http://example.org/sparql';

const dataDumpProbeResult = new DataDumpProbeResult(
  'http://example.org/data.nt',
  new Response('', {
    status: 200,
    headers: {
      'Content-Length': '1000',
      'Content-Type': 'application/n-triples',
    },
  }),
  0,
);

function sparqlProbeResult(): SparqlProbeResult {
  return new SparqlProbeResult(
    SPARQL_URL,
    new Response('{"results":{"bindings":[]}}', {
      status: 200,
      headers: { 'Content-Type': 'application/sparql-results+json' },
    }),
    0,
    'application/sparql-results+json',
  );
}

function makeDataset(): Dataset {
  return new Dataset({
    iri: new URL('http://example.org/dataset'),
    distributions: [
      new Distribution(
        new URL('http://example.org/data.nt'),
        'application/n-triples',
      ),
    ],
  });
}

/** An inner resolver whose probe found a working SPARQL endpoint. */
function innerWithSparqlEndpoint(
  dataset: Dataset,
  sparqlDistribution: Distribution,
  probeResults: ProbeResultType[],
): DistributionResolver {
  return {
    probe: vi.fn().mockResolvedValue(
      new ProbedDistributions(dataset, probeResults, {
        distribution: sparqlDistribution,
        probeResult: probeResults[0],
      }),
    ),
    resolve: vi.fn(),
  };
}

/** An inner resolver whose probe found no SPARQL endpoint. */
function innerNoSparqlEndpoint(
  dataset: Dataset,
  probeResults: ProbeResultType[],
): DistributionResolver {
  return {
    probe: vi
      .fn()
      .mockResolvedValue(new ProbedDistributions(dataset, probeResults, null)),
    resolve: vi.fn(),
  };
}

function makeServer(): SparqlServer & {
  start: ReturnType<typeof vi.fn>;
  stop: ReturnType<typeof vi.fn>;
} {
  return {
    start: vi.fn().mockResolvedValue(undefined),
    stop: vi.fn().mockResolvedValue(undefined),
    queryEndpoint: new URL('http://localhost:7001/sparql'),
  };
}

/** Run both phases, threading callbacks to each, as the pipeline does. */
async function resolve(
  resolver: ImportResolver,
  dataset: Dataset,
  callbacks?: ResolveCallbacks,
) {
  return resolver.resolve(await resolver.probe(dataset, callbacks), callbacks);
}

describe('ImportResolver', () => {
  it('returns the SPARQL endpoint without importing when one is found', async () => {
    const dataset = makeDataset();
    const distribution = Distribution.sparql(new URL(SPARQL_URL));
    const inner = innerWithSparqlEndpoint(dataset, distribution, [
      sparqlProbeResult(),
    ]);
    const mockImporter = { import: vi.fn() };

    const resolver = new ImportResolver(inner, {
      importer: mockImporter,
      server: makeServer(),
    });
    const result = await resolve(resolver, dataset);

    expect(result).toBeInstanceOf(ResolvedDistribution);
    expect((result as ResolvedDistribution).distribution).toBe(distribution);
    expect(mockImporter.import).not.toHaveBeenCalled();
  });

  it('falls back to import when no SPARQL endpoint is found', async () => {
    const dataset = makeDataset();
    const inner = innerNoSparqlEndpoint(dataset, [dataDumpProbeResult]);

    const mockImporter = {
      import: vi
        .fn()
        .mockResolvedValue(
          new ImportSuccessful(
            Distribution.sparql(new URL('http://localhost:7878/sparql')),
            'test-graph',
            42000,
          ),
        ),
    };

    const server = makeServer();
    const resolver = new ImportResolver(inner, {
      importer: mockImporter,
      server,
    });
    const result = await resolve(resolver, dataset);

    expect(result).toBeInstanceOf(ResolvedDistribution);
    expect(mockImporter.import).toHaveBeenCalledWith([
      dataset.distributions[0],
    ]);
    expect(server.start).toHaveBeenCalled();
    const resolved = result as ResolvedDistribution;
    expect(resolved.distribution.accessUrl.toString()).toBe(
      'http://localhost:7001/sparql',
    );
    expect(resolved.probeResults).toHaveLength(1);
    expect(resolved.probeResults[0]).toBeInstanceOf(DataDumpProbeResult);
    expect(resolved.tripleCount).toBe(42000);
  });

  it('sets importedFrom on ResolvedDistribution when import succeeds', async () => {
    const dataset = makeDataset();
    const inner = innerNoSparqlEndpoint(dataset, [dataDumpProbeResult]);

    const importedDistribution = Distribution.sparql(
      new URL('http://localhost:7878/sparql'),
    );
    const mockImporter = {
      import: vi
        .fn()
        .mockResolvedValue(
          new ImportSuccessful(importedDistribution, 'test-graph'),
        ),
    };

    const resolver = new ImportResolver(inner, {
      importer: mockImporter,
      server: makeServer(),
    });
    const result = await resolve(resolver, dataset);

    const resolved = result as ResolvedDistribution;
    expect(resolved.importedFrom).toBe(importedDistribution);
  });

  it('importedFrom is undefined when a SPARQL endpoint is used directly', async () => {
    const dataset = makeDataset();
    const distribution = Distribution.sparql(new URL(SPARQL_URL));
    const inner = innerWithSparqlEndpoint(dataset, distribution, [
      sparqlProbeResult(),
    ]);
    const mockImporter = { import: vi.fn() };

    const resolver = new ImportResolver(inner, {
      importer: mockImporter,
      server: makeServer(),
    });
    const result = await resolve(resolver, dataset);

    expect(result).toBeInstanceOf(ResolvedDistribution);
    expect((result as ResolvedDistribution).importedFrom).toBeUndefined();
  });

  it('returns NoDistributionAvailable with importFailed when import fails', async () => {
    const dataset = makeDataset();
    const inner = innerNoSparqlEndpoint(dataset, [dataDumpProbeResult]);

    const mockImporter = {
      import: vi
        .fn()
        .mockResolvedValue(
          new ImportFailed(
            new Distribution(
              new URL('http://example.org/data.nt'),
              'application/n-triples',
            ),
            'Parse error',
          ),
        ),
    };

    const resolver = new ImportResolver(inner, {
      importer: mockImporter,
      server: makeServer(),
    });
    const result = await resolve(resolver, dataset);

    expect(result).toBeInstanceOf(NoDistributionAvailable);
    const noDistribution = result as NoDistributionAvailable;
    expect(noDistribution.importFailed).toBeInstanceOf(ImportFailed);
    expect(noDistribution.importFailed!.error).toBe('Parse error');
    expect(noDistribution.probeResults).toHaveLength(1);
  });

  it('returns NoDistributionAvailable when importer returns NotSupported', async () => {
    const dataset = makeDataset();
    const inner = innerNoSparqlEndpoint(dataset, [dataDumpProbeResult]);

    const mockImporter = {
      import: vi.fn().mockResolvedValue(new NotSupported()),
    };

    const onImportFailed = vi.fn();
    const resolver = new ImportResolver(inner, {
      importer: mockImporter,
      server: makeServer(),
    });
    const result = await resolve(resolver, dataset, { onImportFailed });

    expect(result).toBeInstanceOf(NoDistributionAvailable);
    const noDistribution = result as NoDistributionAvailable;
    expect(noDistribution.message).toBe('No supported import format available');
    expect(onImportFailed).toHaveBeenCalledWith(
      dataset.distributions[0],
      'No supported import format',
    );
  });

  describe('import strategy', () => {
    it('ignores an available SPARQL endpoint and imports instead', async () => {
      const dataset = makeDataset();
      const distribution = Distribution.sparql(new URL(SPARQL_URL));
      const inner = innerWithSparqlEndpoint(dataset, distribution, [
        dataDumpProbeResult,
      ]);

      const mockImporter = {
        import: vi
          .fn()
          .mockResolvedValue(
            new ImportSuccessful(
              Distribution.sparql(new URL('http://localhost:7878/sparql')),
              'test-graph',
            ),
          ),
      };

      const server = makeServer();
      const resolver = new ImportResolver(inner, {
        importer: mockImporter,
        server,
        strategy: 'import',
      });
      const result = await resolve(resolver, dataset);

      expect(inner.probe).toHaveBeenCalled();
      expect(mockImporter.import).toHaveBeenCalledWith([
        dataset.distributions[0],
      ]);
      expect(result).toBeInstanceOf(ResolvedDistribution);
      expect(server.start).toHaveBeenCalled();
      const res = result as ResolvedDistribution;
      expect(res.distribution.accessUrl.toString()).toBe(
        'http://localhost:7001/sparql',
      );
      expect(res.probeResults).toHaveLength(1);
    });

    it('returns NoDistributionAvailable with probe results from inner when import fails', async () => {
      const dataset = makeDataset();
      const distribution = Distribution.sparql(new URL(SPARQL_URL));
      const inner = innerWithSparqlEndpoint(dataset, distribution, [
        dataDumpProbeResult,
      ]);

      const mockImporter = {
        import: vi
          .fn()
          .mockResolvedValue(
            new ImportFailed(
              new Distribution(
                new URL('http://example.org/data.nt'),
                'application/n-triples',
              ),
              'Parse error',
            ),
          ),
      };

      const resolver = new ImportResolver(inner, {
        importer: mockImporter,
        server: makeServer(),
        strategy: 'import',
      });
      const result = await resolve(resolver, dataset);

      expect(result).toBeInstanceOf(NoDistributionAvailable);
      const noDistribution = result as NoDistributionAvailable;
      expect(noDistribution.probeResults).toHaveLength(1);
      expect(noDistribution.importFailed).toBeInstanceOf(ImportFailed);
    });

    it('default strategy preserves existing sparql-first behaviour', async () => {
      const dataset = makeDataset();
      const distribution = Distribution.sparql(new URL(SPARQL_URL));
      const inner = innerWithSparqlEndpoint(dataset, distribution, [
        sparqlProbeResult(),
      ]);
      const mockImporter = { import: vi.fn() };

      const resolver = new ImportResolver(inner, {
        importer: mockImporter,
        server: makeServer(),
      });
      const result = await resolve(resolver, dataset);

      expect(result).toBeInstanceOf(ResolvedDistribution);
      expect((result as ResolvedDistribution).distribution).toBe(distribution);
      expect(mockImporter.import).not.toHaveBeenCalled();
    });
  });

  describe('reactive dump fallback', () => {
    /** A probed dataset whose chosen source is a SPARQL endpoint, but which
     * also has an importable dump that passed probing. */
    function probedEndpointWithDump(): {
      dataset: Dataset;
      probed: ProbedDistributions;
    } {
      const sparqlDistribution = Distribution.sparql(new URL(SPARQL_URL));
      const downloadDistribution = new Distribution(
        new URL('http://example.org/data.nt'),
        'application/n-triples',
      );
      const dataset = new Dataset({
        iri: new URL('http://example.org/dataset'),
        distributions: [sparqlDistribution, downloadDistribution],
      });
      const sparqlProbe = sparqlProbeResult();
      const probed = new ProbedDistributions(
        dataset,
        [sparqlProbe, dataDumpProbeResult],
        { distribution: sparqlDistribution, probeResult: sparqlProbe },
      );
      return { dataset, probed };
    }

    function dummyInner(): DistributionResolver {
      return { probe: vi.fn(), resolve: vi.fn() };
    }

    it('imports the dump, ignoring the endpoint, when enabled', async () => {
      const { dataset, probed } = probedEndpointWithDump();
      const importedDistribution = Distribution.sparql(
        new URL('http://localhost:7878/sparql'),
      );
      const mockImporter = {
        import: vi
          .fn()
          .mockResolvedValue(
            new ImportSuccessful(importedDistribution, 'test-graph', 99),
          ),
      };
      const server = makeServer();
      const resolver = new ImportResolver(dummyInner(), {
        importer: mockImporter,
        server,
        strategy: 'sparqlWithImportFallback',
      });

      const result = await resolver.resolveFallback(probed);

      expect(mockImporter.import).toHaveBeenCalledWith([
        dataset.distributions[1],
      ]);
      expect(server.start).toHaveBeenCalled();
      expect(result).toBeInstanceOf(ResolvedDistribution);
      const resolved = result as ResolvedDistribution;
      expect(resolved.distribution.accessUrl.toString()).toBe(
        'http://localhost:7001/sparql',
      );
      expect(resolved.importedFrom).toBe(importedDistribution);
      expect(resolved.tripleCount).toBe(99);
    });

    it('returns NoDistributionAvailable without importing when disabled', async () => {
      const { probed } = probedEndpointWithDump();
      const mockImporter = { import: vi.fn() };
      const resolver = new ImportResolver(dummyInner(), {
        importer: mockImporter,
        server: makeServer(),
      });

      const result = await resolver.resolveFallback(probed);

      expect(result).toBeInstanceOf(NoDistributionAvailable);
      expect(mockImporter.import).not.toHaveBeenCalled();
    });

    it('returns NoDistributionAvailable when no dump passed probing', async () => {
      const sparqlDistribution = Distribution.sparql(new URL(SPARQL_URL));
      const dataset = new Dataset({
        iri: new URL('http://example.org/dataset'),
        distributions: [sparqlDistribution],
      });
      const sparqlProbe = sparqlProbeResult();
      const probed = new ProbedDistributions(dataset, [sparqlProbe], {
        distribution: sparqlDistribution,
        probeResult: sparqlProbe,
      });
      const mockImporter = { import: vi.fn() };
      const resolver = new ImportResolver(dummyInner(), {
        importer: mockImporter,
        server: makeServer(),
        strategy: 'sparqlWithImportFallback',
      });

      const result = await resolver.resolveFallback(probed);

      expect(result).toBeInstanceOf(NoDistributionAvailable);
      expect(mockImporter.import).not.toHaveBeenCalled();
    });
  });

  describe('server integration', () => {
    it('starts server after import and uses its endpoint', async () => {
      const dataset = makeDataset();
      const inner = innerNoSparqlEndpoint(dataset, [dataDumpProbeResult]);

      const mockImporter = {
        import: vi
          .fn()
          .mockResolvedValue(
            new ImportSuccessful(
              Distribution.sparql(new URL('http://localhost:7878/sparql')),
              'test-graph',
            ),
          ),
      };

      const server = makeServer();

      const resolver = new ImportResolver(inner, {
        importer: mockImporter,
        server,
      });
      const result = await resolve(resolver, dataset);

      expect(result).toBeInstanceOf(ResolvedDistribution);
      expect(server.start).toHaveBeenCalled();
      const resolved = result as ResolvedDistribution;
      expect(resolved.distribution.accessUrl.toString()).toBe(
        'http://localhost:7001/sparql',
      );
    });

    it('does not start server when a SPARQL endpoint is used', async () => {
      const dataset = makeDataset();
      const distribution = Distribution.sparql(new URL(SPARQL_URL));
      const inner = innerWithSparqlEndpoint(dataset, distribution, [
        sparqlProbeResult(),
      ]);
      const mockImporter = { import: vi.fn() };
      const server = makeServer();

      const resolver = new ImportResolver(inner, {
        importer: mockImporter,
        server,
      });
      await resolve(resolver, dataset);

      expect(server.start).not.toHaveBeenCalled();
    });

    it('propagates Last-Modified from probe to candidate distribution', async () => {
      const dataset = makeDataset();
      const lastModified = new Date('2026-01-15T10:00:00Z');
      const probeResult = new DataDumpProbeResult(
        'http://example.org/data.nt',
        new Response('', {
          status: 200,
          headers: {
            'Content-Length': '1000',
            'Content-Type': 'application/n-triples',
            'Last-Modified': lastModified.toUTCString(),
          },
        }),
        0,
      );
      const inner = innerNoSparqlEndpoint(dataset, [probeResult]);

      const mockImporter = {
        import: vi
          .fn()
          .mockResolvedValue(
            new ImportSuccessful(
              Distribution.sparql(new URL('http://localhost:7878/sparql')),
              'test-graph',
            ),
          ),
      };

      const resolver = new ImportResolver(inner, {
        importer: mockImporter,
        server: makeServer(),
      });
      await resolve(resolver, dataset);

      expect(dataset.distributions[0].lastModified).toEqual(lastModified);
      expect(mockImporter.import).toHaveBeenCalledWith([
        dataset.distributions[0],
      ]);
    });

    it('prefers a newer probe Last-Modified over a stale register date', async () => {
      const staleRegisterDate = new Date('2026-01-01T00:00:00Z');
      const realHttpLastModified = new Date('2026-02-15T10:00:00Z');
      const dataset = new Dataset({
        iri: new URL('http://example.org/dataset'),
        distributions: [
          (() => {
            const distribution = new Distribution(
              new URL('http://example.org/data.nt'),
              'application/n-triples',
            );
            distribution.lastModified = staleRegisterDate;
            return distribution;
          })(),
        ],
      });
      const probeResult = new DataDumpProbeResult(
        'http://example.org/data.nt',
        new Response('', {
          status: 200,
          headers: {
            'Content-Length': '1000',
            'Content-Type': 'application/n-triples',
            'Last-Modified': realHttpLastModified.toUTCString(),
          },
        }),
        0,
      );
      const inner = innerNoSparqlEndpoint(dataset, [probeResult]);

      const mockImporter = {
        import: vi
          .fn()
          .mockResolvedValue(
            new ImportSuccessful(
              Distribution.sparql(new URL('http://localhost:7878/sparql')),
              'test-graph',
            ),
          ),
      };

      const resolver = new ImportResolver(inner, {
        importer: mockImporter,
        server: makeServer(),
      });
      await resolve(resolver, dataset);

      expect(dataset.distributions[0].lastModified).toEqual(
        realHttpLastModified,
      );
    });

    it('keeps a newer register date over an older probe Last-Modified', async () => {
      const newerRegisterDate = new Date('2026-03-01T00:00:00Z');
      const olderHttpLastModified = new Date('2026-02-15T10:00:00Z');
      const dataset = new Dataset({
        iri: new URL('http://example.org/dataset'),
        distributions: [
          (() => {
            const distribution = new Distribution(
              new URL('http://example.org/data.nt'),
              'application/n-triples',
            );
            distribution.lastModified = newerRegisterDate;
            return distribution;
          })(),
        ],
      });
      const probeResult = new DataDumpProbeResult(
        'http://example.org/data.nt',
        new Response('', {
          status: 200,
          headers: {
            'Content-Length': '1000',
            'Content-Type': 'application/n-triples',
            'Last-Modified': olderHttpLastModified.toUTCString(),
          },
        }),
        0,
      );
      const inner = innerNoSparqlEndpoint(dataset, [probeResult]);

      const mockImporter = {
        import: vi
          .fn()
          .mockResolvedValue(
            new ImportSuccessful(
              Distribution.sparql(new URL('http://localhost:7878/sparql')),
              'test-graph',
            ),
          ),
      };

      const resolver = new ImportResolver(inner, {
        importer: mockImporter,
        server: makeServer(),
      });
      await resolve(resolver, dataset);

      expect(dataset.distributions[0].lastModified).toEqual(newerRegisterDate);
    });

    it('preserves subjectFilter from imported distribution', async () => {
      const dataset = makeDataset();
      const inner = innerNoSparqlEndpoint(dataset, [dataDumpProbeResult]);

      const importedDistribution = new Distribution(
        new URL('http://example.org/data.nt'),
        'application/n-triples',
      );
      importedDistribution.subjectFilter = '?s a <http://example.org/Type> .';

      const mockImporter = {
        import: vi
          .fn()
          .mockResolvedValue(
            new ImportSuccessful(importedDistribution, 'test-graph'),
          ),
      };

      const server = makeServer();
      const resolver = new ImportResolver(inner, {
        importer: mockImporter,
        server,
      });
      const result = await resolve(resolver, dataset);

      const resolved = result as ResolvedDistribution;
      expect(resolved.distribution.subjectFilter).toBe(
        '?s a <http://example.org/Type> .',
      );
    });

    it('cleanup stops server', async () => {
      const dataset = makeDataset();
      const distribution = Distribution.sparql(new URL(SPARQL_URL));
      const server = makeServer();
      const resolver = new ImportResolver(
        innerWithSparqlEndpoint(dataset, distribution, [sparqlProbeResult()]),
        { importer: { import: vi.fn() }, server },
      );

      await resolver.cleanup();

      expect(server.stop).toHaveBeenCalled();
    });
  });
});
