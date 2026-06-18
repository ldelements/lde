import { describe, it, expect, vi } from 'vitest';
import { Distribution } from '@lde/dataset';
import {
  SparqlProbeResult,
  DataDumpProbeResult,
  NetworkError,
} from '@lde/distribution-probe';
import { MonitorService, mapProbeResult } from '../src/service.js';
import type { ObservationStore, MonitorConfig } from '../src/types.js';

function createMockStore(): ObservationStore {
  return {
    getLatest: vi.fn().mockResolvedValue(new Map()),
    get: vi.fn().mockResolvedValue(null),
    store: vi.fn().mockImplementation(async (observation) => ({
      id: 'obs-1',
      ...observation,
    })),
    close: vi.fn().mockResolvedValue(undefined),
  };
}

const sparqlDistribution = Distribution.sparql(
  new URL('http://example.org/sparql'),
);

const dumpDistribution = new Distribution(
  new URL('http://example.org/data.nt'),
  'application/n-triples',
);

const testMonitors: MonitorConfig[] = [
  {
    identifier: 'sparql-monitor',
    distribution: sparqlDistribution,
    sparqlQuery: 'ASK { ?s ?p ?o }',
  },
  {
    identifier: 'dump-monitor',
    distribution: dumpDistribution,
  },
];

describe('MonitorService', () => {
  describe('checkNow', () => {
    it('probes a SPARQL distribution and stores the result', async () => {
      const store = createMockStore();
      const probe = vi.fn().mockResolvedValue(
        new SparqlProbeResult(
          'http://example.org/sparql',
          new Response('{"boolean": true}', {
            status: 200,
            headers: { 'Content-Type': 'application/sparql-results+json' },
          }),
          42,
          'application/sparql-results+json',
        ),
      );
      const service = new MonitorService({
        store,
        monitors: testMonitors,
        probe,
      });

      await service.checkNow('sparql-monitor');

      expect(probe).toHaveBeenCalledWith(
        sparqlDistribution,
        expect.objectContaining({ sparqlQuery: 'ASK { ?s ?p ?o }' }),
      );
      expect(store.store).toHaveBeenCalledWith(
        expect.objectContaining({
          monitor: 'sparql-monitor',
          success: true,
          responseTimeMs: 42,
          errorMessage: null,
        }),
      );
    });

    it('probes a data-dump distribution without a sparqlQuery', async () => {
      const store = createMockStore();
      const probe = vi.fn().mockResolvedValue(
        new DataDumpProbeResult(
          'http://example.org/data.nt',
          new Response('', {
            status: 200,
            headers: {
              'Content-Type': 'application/n-triples',
              'Content-Length': '50000',
            },
          }),
          12,
        ),
      );
      const service = new MonitorService({
        store,
        monitors: testMonitors,
        probe,
      });

      await service.checkNow('dump-monitor');

      expect(probe).toHaveBeenCalledWith(
        dumpDistribution,
        expect.not.objectContaining({ sparqlQuery: expect.anything() }),
      );
      expect(store.store).toHaveBeenCalledWith(
        expect.objectContaining({
          monitor: 'dump-monitor',
          success: true,
          responseTimeMs: 12,
        }),
      );
    });

    it('records probe failures as success: false', async () => {
      const store = createMockStore();
      const probe = vi
        .fn()
        .mockResolvedValue(
          new NetworkError(
            'http://example.org/sparql',
            'Connection refused',
            7,
          ),
        );
      const service = new MonitorService({
        store,
        monitors: testMonitors,
        probe,
      });

      await service.checkNow('sparql-monitor');

      expect(store.store).toHaveBeenCalledWith(
        expect.objectContaining({
          monitor: 'sparql-monitor',
          success: false,
          errorMessage: 'Connection refused',
          responseTimeMs: 7,
        }),
      );
    });

    it('throws when monitor not found', async () => {
      const store = createMockStore();
      const service = new MonitorService({ store, monitors: testMonitors });

      await expect(service.checkNow('nonexistent')).rejects.toThrow(
        'Monitor not found: nonexistent',
      );
    });

    it('forwards configured timeoutMs and headers to the probe', async () => {
      const store = createMockStore();
      const probe = vi.fn().mockResolvedValue(
        new SparqlProbeResult(
          'http://example.org/sparql',
          new Response('{"boolean": true}', {
            status: 200,
            headers: { 'Content-Type': 'application/sparql-results+json' },
          }),
          1,
          'application/sparql-results+json',
        ),
      );
      const headers = new Headers({ 'User-Agent': 'TestAgent/1.0' });
      const service = new MonitorService({
        store,
        monitors: testMonitors,
        probe,
        timeoutMs: 10_000,
        headers,
      });

      await service.checkNow('sparql-monitor');

      expect(probe).toHaveBeenCalledWith(
        sparqlDistribution,
        expect.objectContaining({ timeoutMs: 10_000, headers }),
      );
    });

    it('forwards the configured retry count to the probe', async () => {
      const store = createMockStore();
      const probe = vi.fn().mockResolvedValue(
        new SparqlProbeResult(
          'http://example.org/sparql',
          new Response('{"boolean": true}', {
            status: 200,
            headers: { 'Content-Type': 'application/sparql-results+json' },
          }),
          1,
          'application/sparql-results+json',
        ),
      );
      const service = new MonitorService({
        store,
        monitors: testMonitors,
        probe,
        retries: 3,
      });

      await service.checkNow('sparql-monitor');

      expect(probe).toHaveBeenCalledWith(
        sparqlDistribution,
        expect.objectContaining({ retries: 3 }),
      );
    });

    it('omits retries when not configured, leaving the probe default', async () => {
      const store = createMockStore();
      const probe = vi.fn().mockResolvedValue(
        new SparqlProbeResult(
          'http://example.org/sparql',
          new Response('{"boolean": true}', {
            status: 200,
            headers: { 'Content-Type': 'application/sparql-results+json' },
          }),
          1,
          'application/sparql-results+json',
        ),
      );
      const service = new MonitorService({
        store,
        monitors: testMonitors,
        probe,
      });

      await service.checkNow('sparql-monitor');

      expect(probe).toHaveBeenCalledWith(
        sparqlDistribution,
        expect.not.objectContaining({ retries: expect.anything() }),
      );
    });
  });

  describe('checkAll', () => {
    it('checks all monitors in parallel', async () => {
      const store = createMockStore();
      const probe = vi.fn(async (distribution: Distribution) => {
        if (distribution === sparqlDistribution) {
          return new SparqlProbeResult(
            'http://example.org/sparql',
            new Response('{"boolean": true}', {
              status: 200,
              headers: { 'Content-Type': 'application/sparql-results+json' },
            }),
            1,
            'application/sparql-results+json',
          );
        }
        return new DataDumpProbeResult(
          'http://example.org/data.nt',
          new Response('', {
            status: 200,
            headers: {
              'Content-Type': 'application/n-triples',
              'Content-Length': '50000',
            },
          }),
          1,
        );
      });
      const service = new MonitorService({
        store,
        monitors: testMonitors,
        probe,
      });

      await service.checkAll();

      expect(probe).toHaveBeenCalledTimes(2);
      expect(store.store).toHaveBeenCalledTimes(2);
      expect(store.store).toHaveBeenCalledWith(
        expect.objectContaining({ monitor: 'sparql-monitor' }),
      );
      expect(store.store).toHaveBeenCalledWith(
        expect.objectContaining({ monitor: 'dump-monitor' }),
      );
    });
  });

  describe('start/stop', () => {
    it('starts and stops monitoring', () => {
      const store = createMockStore();
      const service = new MonitorService({ store, monitors: testMonitors });

      service.start();
      expect(service.isRunning()).toBe(true);

      service.stop();
      expect(service.isRunning()).toBe(false);
    });
  });
});

describe('mapProbeResult', () => {
  const observedAt = new Date('2026-04-23T10:00:00Z');

  it('maps NetworkError to success: false', () => {
    const result = new NetworkError('http://example.org', 'boom', 50);
    expect(mapProbeResult(result, observedAt)).toEqual({
      success: false,
      responseTimeMs: 50,
      errorMessage: 'boom',
      observedAt,
    });
  });

  it('maps successful SparqlProbeResult to success: true', () => {
    const result = new SparqlProbeResult(
      'http://example.org',
      new Response('{"results":{}}', {
        status: 200,
        headers: { 'Content-Type': 'application/sparql-results+json' },
      }),
      100,
      'application/sparql-results+json',
    );
    expect(mapProbeResult(result, observedAt).success).toBe(true);
  });

  it('maps failureReason into errorMessage when probe is unsuccessful', () => {
    const result = new DataDumpProbeResult(
      'http://example.org/data.nt',
      new Response('', {
        status: 200,
        headers: { 'Content-Type': 'text/turtle' },
      }),
      20,
      'Distribution is empty',
    );
    expect(mapProbeResult(result, observedAt)).toEqual({
      success: false,
      responseTimeMs: 20,
      errorMessage: 'Distribution is empty',
      observedAt,
    });
  });

  it('falls back to HTTP status when there is no failureReason or warnings', () => {
    const result = new SparqlProbeResult(
      'http://example.org',
      new Response('', { status: 502, statusText: 'Bad Gateway' }),
      30,
      'application/sparql-results+json',
    );
    expect(mapProbeResult(result, observedAt).errorMessage).toBe(
      'HTTP 502 Bad Gateway',
    );
  });
});
