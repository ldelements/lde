import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Pipeline, type PipelinePlugin } from '../src/pipeline.js';
import { Dataset, Distribution } from '@lde/dataset';
import { Stage } from '../src/stage.js';
import { NotSupported } from '../src/sparql/executor.js';
import { ImportFailed } from '@lde/sparql-importer';
import {
  ResolvedDistribution,
  NoDistributionAvailable,
  ProbedDistributions,
  type DistributionResolver,
  type ResolveCallbacks,
} from '../src/distribution/resolver.js';
import {
  SparqlProbeResult,
  DataDumpProbeResult,
  NetworkError,
  type ProbeResultType,
} from '@lde/distribution-probe';
import type { Writer } from '../src/writer/writer.js';
import type { ProgressReporter } from '../src/progressReporter.js';
import type { StageOutputResolver } from '../src/stageOutputResolver.js';
import type { DatasetSelector } from '../src/selector.js';
import { sourceFingerprint } from '../src/provenance/sourceFingerprint.js';
import type { ProvenanceStore } from '../src/provenance/store.js';
import type { ProcessingRecord } from '../src/provenance/record.js';
import { Paginator } from '@lde/dataset-registry-client';
import { DataFactory } from 'n3';
import type { Quad } from '@rdfjs/types';

function makeDataset(iri = 'http://example.org/dataset'): Dataset {
  return new Dataset({
    iri: new URL(iri),
    distributions: [],
  });
}

const sparqlDistribution = Distribution.sparql(
  new URL('http://example.org/sparql'),
);

function makeDatasetSelector(...datasets: Dataset[]): DatasetSelector {
  return {
    select: async () => new Paginator(async () => datasets, datasets.length),
  };
}

function makeResolver(
  result: ResolvedDistribution | NoDistributionAvailable,
  /** Distributions and probe results to fire via onProbe callback. */
  probes?: Array<{ distribution: Distribution; result: ProbeResultType }>,
): DistributionResolver {
  return {
    probe: vi.fn(async (dataset: Dataset, callbacks?: ResolveCallbacks) => {
      for (const p of probes ?? []) {
        callbacks?.onProbe?.(p.distribution, p.result);
      }
      return new ProbedDistributions(
        dataset,
        (probes ?? []).map((p) => p.result),
        null,
      );
    }),
    resolve: vi.fn(async () => result),
  };
}

function makeResolvedDistribution(): ResolvedDistribution {
  return new ResolvedDistribution(sparqlDistribution, []);
}

function makeWriter(): Writer & {
  write: ReturnType<typeof vi.fn>;
  flush: ReturnType<typeof vi.fn>;
  reset: ReturnType<typeof vi.fn>;
} {
  return {
    write: vi.fn().mockResolvedValue(undefined),
    flush: vi.fn().mockResolvedValue(undefined),
    reset: vi.fn().mockResolvedValue(undefined),
  };
}

type RequiredReporter = Required<ProgressReporter> & {
  [K in keyof Required<ProgressReporter>]: ReturnType<typeof vi.fn>;
};

function makeReporter(): RequiredReporter {
  return {
    pipelineStart: vi.fn<NonNullable<ProgressReporter['pipelineStart']>>(),
    datasetsSelected:
      vi.fn<NonNullable<ProgressReporter['datasetsSelected']>>(),
    datasetStart: vi.fn<NonNullable<ProgressReporter['datasetStart']>>(),
    distributionProbed:
      vi.fn<NonNullable<ProgressReporter['distributionProbed']>>(),
    importStarted: vi.fn<NonNullable<ProgressReporter['importStarted']>>(),
    importFailed: vi.fn<NonNullable<ProgressReporter['importFailed']>>(),
    distributionValidated:
      vi.fn<NonNullable<ProgressReporter['distributionValidated']>>(),
    distributionSelected:
      vi.fn<NonNullable<ProgressReporter['distributionSelected']>>(),
    stageStart: vi.fn<NonNullable<ProgressReporter['stageStart']>>(),
    stageProgress: vi.fn<NonNullable<ProgressReporter['stageProgress']>>(),
    stageComplete: vi.fn<NonNullable<ProgressReporter['stageComplete']>>(),
    stageFailed: vi.fn<NonNullable<ProgressReporter['stageFailed']>>(),
    stageSkipped: vi.fn<NonNullable<ProgressReporter['stageSkipped']>>(),
    datasetValidated:
      vi.fn<NonNullable<ProgressReporter['datasetValidated']>>(),
    datasetComplete: vi.fn<NonNullable<ProgressReporter['datasetComplete']>>(),
    datasetSkipped: vi.fn<NonNullable<ProgressReporter['datasetSkipped']>>(),
    pipelineComplete:
      vi.fn<NonNullable<ProgressReporter['pipelineComplete']>>(),
    timeoutTightened:
      vi.fn<NonNullable<ProgressReporter['timeoutTightened']>>(),
    timeoutRelaxed: vi.fn<NonNullable<ProgressReporter['timeoutRelaxed']>>(),
  };
}

function makeStageOutputResolver(): StageOutputResolver & {
  resolve: ReturnType<typeof vi.fn>;
  cleanup: ReturnType<typeof vi.fn>;
} {
  return {
    resolve: vi
      .fn<StageOutputResolver['resolve']>()
      .mockResolvedValue(
        Distribution.sparql(new URL('http://resolved.example.org/sparql')),
      ),
    cleanup: vi
      .fn<StageOutputResolver['cleanup']>()
      .mockResolvedValue(undefined),
  };
}

function makeStage(
  name: string,
  result: NotSupported | void = undefined,
  subStages: Stage[] = [],
): Stage {
  const stage = new Stage({ name, executors: [], stages: subStages });
  vi.spyOn(stage, 'run').mockResolvedValue(result);
  return stage;
}

describe('Pipeline', () => {
  let dataset: Dataset;
  let writer: ReturnType<typeof makeWriter>;

  beforeEach(() => {
    dataset = makeDataset();
    writer = makeWriter();
  });

  describe('flat stages', () => {
    it('runs stages with the same distribution and user writer', async () => {
      const stage1 = makeStage('stage1');
      const stage2 = makeStage('stage2');

      const pipeline = new Pipeline({
        datasetSelector: makeDatasetSelector(dataset),
        stages: [stage1, stage2],
        writers: writer,
        distributionResolver: makeResolver(makeResolvedDistribution()),
      });

      await pipeline.run();

      expect(stage1.run).toHaveBeenCalledWith(
        dataset,
        sparqlDistribution,
        writer,
        expect.objectContaining({ onProgress: expect.any(Function) }),
      );
      expect(stage2.run).toHaveBeenCalledWith(
        dataset,
        sparqlDistribution,
        writer,
        expect.objectContaining({ onProgress: expect.any(Function) }),
      );
    });

    it('skips dataset when no distribution is available', async () => {
      const stage = makeStage('stage1');
      const reporter = makeReporter();

      const pipeline = new Pipeline({
        datasetSelector: makeDatasetSelector(dataset),
        stages: [stage],
        writers: writer,
        distributionResolver: makeResolver(
          new NoDistributionAvailable(dataset, 'No SPARQL endpoint', []),
        ),
        reporter,
      });

      await pipeline.run();

      expect(stage.run).not.toHaveBeenCalled();
      expect(reporter.datasetSkipped).toHaveBeenCalledWith(
        dataset,
        'No SPARQL endpoint',
      );
    });

    it('fans out to multiple writers at different speeds', async () => {
      const quadsA: Quad[] = [];
      const quadsB: Quad[] = [];
      const writerA: Writer = {
        async write(_dataset, quads) {
          for await (const quad of quads) quadsA.push(quad);
        },
        flush: vi.fn().mockResolvedValue(undefined),
      };
      const writerB: Writer = {
        async write(_dataset, quads) {
          for await (const quad of quads) {
            // Simulate a slow consumer (e.g. HTTP-based SparqlUpdateWriter).
            await new Promise((resolve) => setTimeout(resolve, 50));
            quadsB.push(quad);
          }
        },
        flush: vi.fn().mockResolvedValue(undefined),
      };

      const testQuads = [
        DataFactory.quad(
          DataFactory.namedNode('http://s1'),
          DataFactory.namedNode('http://p1'),
          DataFactory.namedNode('http://o1'),
        ),
        DataFactory.quad(
          DataFactory.namedNode('http://s2'),
          DataFactory.namedNode('http://p2'),
          DataFactory.namedNode('http://o2'),
        ),
        DataFactory.quad(
          DataFactory.namedNode('http://s3'),
          DataFactory.namedNode('http://p3'),
          DataFactory.namedNode('http://o3'),
        ),
      ];

      const stage = new Stage({ name: 'stage1', executors: [] });
      vi.spyOn(stage, 'run').mockImplementation(
        async (_dataset, _distribution, stageWriter) => {
          await stageWriter.write(
            _dataset,
            (async function* () {
              yield* testQuads;
            })(),
          );
        },
      );

      const pipeline = new Pipeline({
        datasetSelector: makeDatasetSelector(dataset),
        stages: [stage],
        writers: [writerA, writerB],
        distributionResolver: makeResolver(makeResolvedDistribution()),
      });

      await pipeline.run();

      expect(quadsA).toEqual(testQuads);
      expect(quadsB).toEqual(testQuads);
    });

    it('calls flush on writer after all stages complete for a dataset', async () => {
      const stage1 = makeStage('stage1');
      const stage2 = makeStage('stage2');

      const pipeline = new Pipeline({
        datasetSelector: makeDatasetSelector(dataset),
        stages: [stage1, stage2],
        writers: writer,
        distributionResolver: makeResolver(makeResolvedDistribution()),
      });

      await pipeline.run();

      expect(writer.flush).toHaveBeenCalledWith(dataset);
      expect(writer.flush).toHaveBeenCalledTimes(1);
    });

    it('calls flush once per dataset', async () => {
      const dataset1 = makeDataset('http://example.org/dataset/1');
      const dataset2 = makeDataset('http://example.org/dataset/2');
      const stage = makeStage('stage1');

      const pipeline = new Pipeline({
        datasetSelector: makeDatasetSelector(dataset1, dataset2),
        stages: [stage],
        writers: writer,
        distributionResolver: makeResolver(makeResolvedDistribution()),
      });

      await pipeline.run();

      expect(writer.flush).toHaveBeenCalledTimes(2);
      expect(writer.flush).toHaveBeenCalledWith(dataset1);
      expect(writer.flush).toHaveBeenCalledWith(dataset2);
    });

    it('skips stage returning NotSupported', async () => {
      const stage1 = makeStage(
        'stage1',
        new NotSupported('Not supported reason'),
      );
      const stage2 = makeStage('stage2');
      const reporter = makeReporter();

      const pipeline = new Pipeline({
        datasetSelector: makeDatasetSelector(dataset),
        stages: [stage1, stage2],
        writers: writer,
        distributionResolver: makeResolver(makeResolvedDistribution()),
        reporter,
      });

      await pipeline.run();

      expect(reporter.stageSkipped).toHaveBeenCalledWith(
        'stage1',
        'Not supported reason',
      );
      expect(stage2.run).toHaveBeenCalled();
    });
  });

  describe('sub-stage chaining', () => {
    it('runs parent with FileWriter, children chain off parent output', async () => {
      const resolvedDistribution = Distribution.sparql(
        new URL('http://resolved.example.org/sparql'),
      );
      const stageOutputResolver = makeStageOutputResolver();
      stageOutputResolver.resolve.mockResolvedValue(resolvedDistribution);

      const child = makeStage('child');
      const parent = makeStage('parent', undefined, [child]);

      const pipeline = new Pipeline({
        datasetSelector: makeDatasetSelector(dataset),
        stages: [parent],
        writers: writer,
        distributionResolver: makeResolver(makeResolvedDistribution()),
        chaining: {
          stageOutputResolver,
          outputDir: '/tmp/test',
        },
      });

      await pipeline.run();

      // Parent should get a FileWriter, not the user writer.
      const parentWriter = (parent.run as ReturnType<typeof vi.fn>).mock
        .calls[0][2];
      expect(parentWriter).not.toBe(writer);
      expect(parentWriter.constructor.name).toBe('FileWriter');

      // Child should receive the resolved distribution.
      const childDistribution = (child.run as ReturnType<typeof vi.fn>).mock
        .calls[0][1];
      expect(childDistribution).toBe(resolvedDistribution);

      // Resolver should be called with the parent's output path.
      expect(stageOutputResolver.resolve).toHaveBeenCalled();
    });

    it('calls stageOutputResolver between chained stages', async () => {
      const dist1 = Distribution.sparql(
        new URL('http://resolved.example.org/sparql/1'),
      );
      const dist2 = Distribution.sparql(
        new URL('http://resolved.example.org/sparql/2'),
      );
      const stageOutputResolver = makeStageOutputResolver();
      stageOutputResolver.resolve
        .mockResolvedValueOnce(dist1)
        .mockResolvedValueOnce(dist2);

      const child1 = makeStage('child1');
      const child2 = makeStage('child2');
      const parent = makeStage('parent', undefined, [child1, child2]);

      const pipeline = new Pipeline({
        datasetSelector: makeDatasetSelector(dataset),
        stages: [parent],
        writers: writer,
        distributionResolver: makeResolver(makeResolvedDistribution()),
        chaining: {
          stageOutputResolver,
          outputDir: '/tmp/test',
        },
      });

      await pipeline.run();

      // resolve() called: once for parent→child1, once for child1→child2.
      expect(stageOutputResolver.resolve).toHaveBeenCalledTimes(2);

      // child1 gets dist1 (resolved from parent output).
      expect((child1.run as ReturnType<typeof vi.fn>).mock.calls[0][1]).toBe(
        dist1,
      );
      // child2 gets dist2 (resolved from child1 output).
      expect((child2.run as ReturnType<typeof vi.fn>).mock.calls[0][1]).toBe(
        dist2,
      );
    });

    it('concatenates all output files to user writer', async () => {
      const stageOutputResolver = makeStageOutputResolver();
      const child = makeStage('child');
      const parent = makeStage('parent', undefined, [child]);

      const pipeline = new Pipeline({
        datasetSelector: makeDatasetSelector(dataset),
        stages: [parent],
        writers: writer,
        distributionResolver: makeResolver(makeResolvedDistribution()),
        chaining: {
          stageOutputResolver,
          outputDir: '/tmp/test',
        },
      });

      await pipeline.run();

      // writer.write() should have been called with the dataset and an async iterable.
      expect(writer.write).toHaveBeenCalledWith(dataset, expect.anything());
    });

    it('cleans up on success', async () => {
      const stageOutputResolver = makeStageOutputResolver();
      const child = makeStage('child');
      const parent = makeStage('parent', undefined, [child]);

      const pipeline = new Pipeline({
        datasetSelector: makeDatasetSelector(dataset),
        stages: [parent],
        writers: writer,
        distributionResolver: makeResolver(makeResolvedDistribution()),
        chaining: {
          stageOutputResolver,
          outputDir: '/tmp/test',
        },
      });

      await pipeline.run();

      expect(stageOutputResolver.cleanup).toHaveBeenCalledTimes(1);
    });

    it('cleans up on error', async () => {
      const stageOutputResolver = makeStageOutputResolver();
      const child = makeStage('child');
      const failingParent = makeStage('failing', undefined, [child]);
      vi.spyOn(failingParent, 'run').mockRejectedValue(
        new Error('Stage failed'),
      );

      const pipeline = new Pipeline({
        datasetSelector: makeDatasetSelector(dataset),
        stages: [failingParent],
        writers: writer,
        distributionResolver: makeResolver(makeResolvedDistribution()),
        chaining: {
          stageOutputResolver,
          outputDir: '/tmp/test',
        },
      });

      await pipeline.run();

      expect(stageOutputResolver.cleanup).toHaveBeenCalledTimes(1);
    });

    it('reports a chained stage that returns NotSupported and skips the concat', async () => {
      const stageOutputResolver = makeStageOutputResolver();
      const child = makeStage('child');
      const parent = makeStage(
        'parent',
        new NotSupported('No items selected'),
        [child],
      );

      const pipeline = new Pipeline({
        datasetSelector: makeDatasetSelector(dataset),
        stages: [parent],
        writers: writer,
        distributionResolver: makeResolver(makeResolvedDistribution()),
        chaining: {
          stageOutputResolver,
          outputDir: '/tmp/test',
        },
      });

      // The chain throws internally; the pipeline catches it, so run resolves.
      await pipeline.run();

      // The concat to the user writer never runs, and resources are cleaned up.
      expect(writer.write).not.toHaveBeenCalled();
      expect(stageOutputResolver.cleanup).toHaveBeenCalledTimes(1);
    });

    it('validates chaining is required for sub-stages', () => {
      const child = makeStage('child');
      const parent = makeStage('parent', undefined, [child]);

      expect(
        () =>
          new Pipeline({
            datasetSelector: makeDatasetSelector(dataset),
            stages: [parent],
            writers: writer,
            distributionResolver: makeResolver(makeResolvedDistribution()),
          }),
      ).toThrow('chaining is required when any stage has sub-stages');
    });
  });

  describe('mixed flat and chained stages', () => {
    it('runs flat stages with user writer and chained stages through chain', async () => {
      const stageOutputResolver = makeStageOutputResolver();

      const flatStage = makeStage('flat');
      const child = makeStage('child');
      const chainedParent = makeStage('chained', undefined, [child]);

      const pipeline = new Pipeline({
        datasetSelector: makeDatasetSelector(dataset),
        stages: [flatStage, chainedParent],
        writers: writer,
        distributionResolver: makeResolver(makeResolvedDistribution()),
        chaining: {
          stageOutputResolver,
          outputDir: '/tmp/test',
        },
      });

      await pipeline.run();

      // Flat stage gets user writer.
      const flatWriter = (flatStage.run as ReturnType<typeof vi.fn>).mock
        .calls[0][2];
      expect(flatWriter).toBe(writer);

      // Chained parent gets FileWriter.
      const chainedWriter = (chainedParent.run as ReturnType<typeof vi.fn>).mock
        .calls[0][2];
      expect(chainedWriter).not.toBe(writer);
      expect(chainedWriter.constructor.name).toBe('FileWriter');
    });
  });

  describe('reporter', () => {
    it('calls reporter hooks in order', async () => {
      const reporter = makeReporter();
      const stage = makeStage('stage1');

      const pipeline = new Pipeline({
        name: 'my-pipeline',
        datasetSelector: makeDatasetSelector(dataset),
        stages: [stage],
        writers: writer,
        distributionResolver: makeResolver(makeResolvedDistribution()),
        reporter,
      });

      await pipeline.run();

      const callOrder = [
        reporter.pipelineStart,
        reporter.datasetStart,
        reporter.distributionSelected,
        reporter.stageStart,
        reporter.stageComplete,
        reporter.datasetComplete,
        reporter.pipelineComplete,
      ];

      for (let i = 0; i < callOrder.length; i++) {
        expect(callOrder[i]).toHaveBeenCalledTimes(1);
        if (i > 0) {
          expect(callOrder[i].mock.invocationCallOrder[0]).toBeGreaterThan(
            callOrder[i - 1].mock.invocationCallOrder[0],
          );
        }
      }

      expect(reporter.pipelineStart).toHaveBeenCalledWith('my-pipeline');
      expect(reporter.datasetStart).toHaveBeenCalledWith(dataset);
      expect(reporter.stageStart).toHaveBeenCalledWith('stage1');
      expect(reporter.pipelineComplete).toHaveBeenCalledWith(
        expect.objectContaining({ duration: expect.any(Number) }),
      );
    });

    it('calls reporter hooks for parent and child stages in chain', async () => {
      const reporter = makeReporter();
      const stageOutputResolver = makeStageOutputResolver();
      const child = makeStage('child');
      const parent = makeStage('parent', undefined, [child]);

      const pipeline = new Pipeline({
        datasetSelector: makeDatasetSelector(dataset),
        stages: [parent],
        writers: writer,
        distributionResolver: makeResolver(makeResolvedDistribution()),
        chaining: {
          stageOutputResolver,
          outputDir: '/tmp/test',
        },
        reporter,
      });

      await pipeline.run();

      expect(reporter.stageStart).toHaveBeenCalledWith('parent');
      expect(reporter.stageStart).toHaveBeenCalledWith('child');
      expect(reporter.stageComplete).toHaveBeenCalledWith(
        'parent',
        expect.objectContaining({ duration: expect.any(Number) }),
      );
      expect(reporter.stageComplete).toHaveBeenCalledWith(
        'child',
        expect.objectContaining({ duration: expect.any(Number) }),
      );
    });

    it('works without reporter', async () => {
      const pipeline = new Pipeline({
        datasetSelector: makeDatasetSelector(dataset),
        stages: [makeStage('stage1')],
        writers: writer,
        distributionResolver: makeResolver(makeResolvedDistribution()),
      });

      await expect(pipeline.run()).resolves.toBeUndefined();
    });

    it('notifies every reporter when passed an array', async () => {
      const first = makeReporter();
      const second = makeReporter();

      const pipeline = new Pipeline({
        name: 'my-pipeline',
        datasetSelector: makeDatasetSelector(dataset),
        stages: [makeStage('stage1')],
        writers: writer,
        distributionResolver: makeResolver(makeResolvedDistribution()),
        reporter: [first, second],
      });

      await pipeline.run();

      for (const reporter of [first, second]) {
        expect(reporter.pipelineStart).toHaveBeenCalledWith('my-pipeline');
        expect(reporter.stageStart).toHaveBeenCalledWith('stage1');
        expect(reporter.pipelineComplete).toHaveBeenCalledTimes(1);
      }
    });

    it('distributionProbed called once per distribution with correct result', async () => {
      const reporter = makeReporter();

      const sparqlDist = Distribution.sparql(
        new URL('http://example.org/sparql'),
      );
      const dataDumpDist = new Distribution(
        new URL('http://example.org/data.nt'),
        'application/n-triples',
      );
      const downDist = new Distribution(
        new URL('http://example.org/down'),
        'application/n-triples',
      );

      const datasetWithDists = new Dataset({
        iri: new URL('http://example.org/dataset'),
        distributions: [sparqlDist, dataDumpDist, downDist],
      });

      const sparqlResult = new SparqlProbeResult(
        'http://example.org/sparql',
        new Response('', {
          status: 200,
          headers: { 'Content-Type': 'application/sparql-results+json' },
        }),
        0,
        'application/sparql-results+json',
      );
      const dataDumpResult = new DataDumpProbeResult(
        'http://example.org/data.nt',
        new Response('', { status: 404 }),
        0,
      );
      const networkError = new NetworkError(
        'http://example.org/down',
        'Connection refused',
        0,
      );

      const pipeline = new Pipeline({
        datasetSelector: makeDatasetSelector(datasetWithDists),
        stages: [makeStage('stage1')],
        writers: writer,
        distributionResolver: makeResolver(
          new ResolvedDistribution(sparqlDist, [
            sparqlResult,
            dataDumpResult,
            networkError,
          ]),
          [
            { distribution: sparqlDist, result: sparqlResult },
            { distribution: dataDumpDist, result: dataDumpResult },
            { distribution: downDist, result: networkError },
          ],
        ),
        reporter,
      });

      await pipeline.run();

      expect(reporter.distributionProbed).toHaveBeenCalledTimes(3);
      expect(reporter.distributionProbed).toHaveBeenCalledWith({
        distribution: sparqlDist,
        type: 'sparql',
        available: true,
        statusCode: 200,
        warnings: [],
        fingerprint: sourceFingerprint(sparqlDist, sparqlResult),
      });
      expect(reporter.distributionProbed).toHaveBeenCalledWith({
        distribution: dataDumpDist,
        type: 'data-dump',
        available: false,
        statusCode: 404,
        warnings: [],
        fingerprint: sourceFingerprint(dataDumpDist, dataDumpResult),
      });
      expect(reporter.distributionProbed).toHaveBeenCalledWith({
        distribution: downDist,
        type: 'network-error',
        available: false,
        error: 'Connection refused',
        warnings: [],
        fingerprint: sourceFingerprint(downDist, networkError),
      });
    });

    it('distributionSelected reports importedFrom when import was used', async () => {
      const reporter = makeReporter();
      const importedFromDistribution = new Distribution(
        new URL('http://example.org/data.nt'),
        'application/n-triples',
      );
      const resolved = new ResolvedDistribution(
        sparqlDistribution,
        [],
        importedFromDistribution,
        1000,
        42000,
      );

      const pipeline = new Pipeline({
        datasetSelector: makeDatasetSelector(dataset),
        stages: [makeStage('stage1')],
        writers: writer,
        distributionResolver: makeResolver(resolved),
        reporter,
      });

      await pipeline.run();

      expect(reporter.distributionSelected).toHaveBeenCalledWith(
        dataset,
        sparqlDistribution,
        importedFromDistribution,
        1000,
        42000,
      );
    });

    it('calls importStarted before distributionSelected when a data dump is imported', async () => {
      const reporter = makeReporter();
      const importedFromDistribution = new Distribution(
        new URL('http://example.org/data.nt'),
        'application/n-triples',
      );
      const resolved = new ResolvedDistribution(
        sparqlDistribution,
        [],
        importedFromDistribution,
        1000,
        42000,
      );

      const resolver: DistributionResolver = {
        probe: vi.fn(
          async (probedDataset: Dataset) =>
            new ProbedDistributions(probedDataset, [], null),
        ),
        resolve: vi.fn(async (_probed, callbacks?: ResolveCallbacks) => {
          callbacks?.onImportStart?.();
          return resolved;
        }),
      };

      const pipeline = new Pipeline({
        datasetSelector: makeDatasetSelector(dataset),
        stages: [makeStage('stage1')],
        writers: writer,
        distributionResolver: resolver,
        reporter,
      });

      await pipeline.run();

      expect(reporter.importStarted).toHaveBeenCalledTimes(1);
      expect(reporter.importStarted.mock.invocationCallOrder[0]).toBeLessThan(
        reporter.distributionSelected.mock.invocationCallOrder[0],
      );
    });

    it('distributionProbed called even when dataset is skipped', async () => {
      const reporter = makeReporter();
      const downDist = new Distribution(
        new URL('http://example.org/down'),
        'application/n-triples',
      );
      const datasetWithDist = new Dataset({
        iri: new URL('http://example.org/dataset'),
        distributions: [downDist],
      });
      const networkError = new NetworkError(
        'http://example.org/down',
        'Connection refused',
        0,
      );

      const pipeline = new Pipeline({
        datasetSelector: makeDatasetSelector(datasetWithDist),
        stages: [makeStage('stage1')],
        writers: writer,
        distributionResolver: makeResolver(
          new NoDistributionAvailable(datasetWithDist, 'No SPARQL endpoint', [
            networkError,
          ]),
          [{ distribution: downDist, result: networkError }],
        ),
        reporter,
      });

      await pipeline.run();

      expect(reporter.distributionProbed).toHaveBeenCalledTimes(1);
      expect(reporter.distributionProbed).toHaveBeenCalledWith({
        distribution: downDist,
        type: 'network-error',
        available: false,
        error: 'Connection refused',
        warnings: [],
        fingerprint: sourceFingerprint(downDist, networkError),
      });
      expect(reporter.distributionSelected).not.toHaveBeenCalled();
    });

    it('works with partial reporter that only implements pipelineStart', async () => {
      const partialReporter: ProgressReporter = {
        pipelineStart: vi.fn(),
      };

      const pipeline = new Pipeline({
        name: 'my-pipeline',
        datasetSelector: makeDatasetSelector(dataset),
        stages: [makeStage('stage1')],
        writers: writer,
        distributionResolver: makeResolver(makeResolvedDistribution()),
        reporter: partialReporter,
      });

      await expect(pipeline.run()).resolves.toBeUndefined();
      expect(partialReporter.pipelineStart).toHaveBeenCalledWith('my-pipeline');
    });
  });

  describe('multiple datasets', () => {
    it('processes each dataset through all stages', async () => {
      const dataset1 = makeDataset('http://example.org/dataset/1');
      const dataset2 = makeDataset('http://example.org/dataset/2');
      const stage = makeStage('stage1');
      const resolver = makeResolver(makeResolvedDistribution());

      const pipeline = new Pipeline({
        datasetSelector: makeDatasetSelector(dataset1, dataset2),
        stages: [stage],
        writers: writer,
        distributionResolver: resolver,
      });

      await pipeline.run();

      expect(stage.run).toHaveBeenCalledTimes(2);
      expect(resolver.resolve).toHaveBeenCalledTimes(2);
    });
  });

  describe('error handling', () => {
    it('continues to next dataset when a stage throws', async () => {
      const dataset1 = makeDataset('http://example.org/dataset/1');
      const dataset2 = makeDataset('http://example.org/dataset/2');

      const failingStage = makeStage('failing');
      let callCount = 0;
      vi.spyOn(failingStage, 'run').mockImplementation(async () => {
        callCount++;
        if (callCount === 1) {
          throw new Error('Stage failed');
        }
      });

      const reporter = makeReporter();

      const pipeline = new Pipeline({
        datasetSelector: makeDatasetSelector(dataset1, dataset2),
        stages: [failingStage],
        writers: writer,
        distributionResolver: makeResolver(makeResolvedDistribution()),
        reporter,
      });

      await pipeline.run();

      // Both datasets should be attempted.
      expect(failingStage.run).toHaveBeenCalledTimes(2);
      expect(reporter.datasetComplete).toHaveBeenCalledTimes(2);
      expect(reporter.stageFailed).toHaveBeenCalledWith(
        'failing',
        expect.any(Error),
      );
    });

    it('continues to next stage when a stage throws', async () => {
      const failingStage = makeStage('failing');
      vi.spyOn(failingStage, 'run').mockRejectedValue(
        new Error('Stage failed'),
      );
      const okStage = makeStage('ok');
      const reporter = makeReporter();

      const pipeline = new Pipeline({
        datasetSelector: makeDatasetSelector(dataset),
        stages: [failingStage, okStage],
        writers: writer,
        distributionResolver: makeResolver(makeResolvedDistribution()),
        reporter,
      });

      await pipeline.run();

      expect(okStage.run).toHaveBeenCalledTimes(1);
      expect(reporter.stageFailed).toHaveBeenCalledWith(
        'failing',
        expect.any(Error),
      );
      expect(reporter.datasetComplete).toHaveBeenCalledTimes(1);
    });

    it('continues to next top-level stage when a chain throws', async () => {
      const stageOutputResolver = makeStageOutputResolver();

      const child = makeStage('child');
      const chainedParent = makeStage('chained', undefined, [child]);
      vi.spyOn(chainedParent, 'run').mockRejectedValue(
        new Error('Chain failed'),
      );

      const flatStage = makeStage('flat');
      const reporter = makeReporter();

      const pipeline = new Pipeline({
        datasetSelector: makeDatasetSelector(dataset),
        stages: [chainedParent, flatStage],
        writers: writer,
        distributionResolver: makeResolver(makeResolvedDistribution()),
        chaining: {
          stageOutputResolver,
          outputDir: '/tmp/test',
        },
        reporter,
      });

      await pipeline.run();

      expect(flatStage.run).toHaveBeenCalledTimes(1);
      expect(reporter.stageFailed).toHaveBeenCalledWith(
        'chained',
        expect.any(Error),
      );
    });
  });

  describe('reactive dump fallback', () => {
    const endpointDistribution = Distribution.sparql(
      new URL('http://endpoint.example.org/sparql'),
    );
    const importedDistribution = Distribution.sparql(
      new URL('http://localhost/imported/sparql'),
    );
    const dumpDistribution = new Distribution(
      new URL('http://example.org/dump.ttl'),
      'application/n-triples',
    );

    /**
     * A resolver whose endpoint resolves first, but whose `resolveFallback`
     * yields a freshly imported dump distribution.
     */
    function makeFallbackResolver(): DistributionResolver & {
      resolveFallback: ReturnType<typeof vi.fn>;
    } {
      return {
        probe: vi.fn(
          async (ds: Dataset) => new ProbedDistributions(ds, [], null),
        ),
        resolve: vi.fn(
          async () => new ResolvedDistribution(endpointDistribution, []),
        ),
        resolveFallback: vi.fn(
          async () =>
            new ResolvedDistribution(
              importedDistribution,
              [],
              dumpDistribution,
            ),
        ),
      };
    }

    it('re-runs all stages against the imported dump when an endpoint stage hard-fails', async () => {
      // Fails on the endpoint (first call), succeeds on the dump (re-run).
      const stage = makeStage('aggregate');
      vi.spyOn(stage, 'run').mockImplementation(
        async (_dataset, distribution) => {
          if (distribution === endpointDistribution) {
            throw new Error('endpoint killed the heavy query');
          }
        },
      );
      const resolver = makeFallbackResolver();

      const pipeline = new Pipeline({
        datasetSelector: makeDatasetSelector(dataset),
        stages: [stage],
        writers: writer,
        distributionResolver: resolver,
      });

      await pipeline.run();

      expect(resolver.resolveFallback).toHaveBeenCalledTimes(1);
      // Ran once against the endpoint (threw), then again against the dump.
      expect(stage.run).toHaveBeenCalledTimes(2);
      expect(stage.run).toHaveBeenLastCalledWith(
        dataset,
        importedDistribution,
        writer,
        expect.objectContaining({ onProgress: expect.any(Function) }),
      );
    });

    it('resets the writer before re-running so endpoint output is discarded', async () => {
      const stage = makeStage('aggregate');
      vi.spyOn(stage, 'run').mockImplementation(
        async (_dataset, distribution) => {
          if (distribution === endpointDistribution) {
            throw new Error('endpoint killed the heavy query');
          }
        },
      );
      const resolver = makeFallbackResolver();

      const pipeline = new Pipeline({
        datasetSelector: makeDatasetSelector(dataset),
        stages: [stage],
        writers: writer,
        distributionResolver: resolver,
      });

      await pipeline.run();

      expect(writer.reset).toHaveBeenCalledTimes(1);
      expect(writer.reset).toHaveBeenCalledWith(dataset);
      // The reset must precede the dump re-run, or its output would append to
      // the discarded endpoint-sourced quads.
      const resetOrder = writer.reset.mock.invocationCallOrder[0];
      const reRunOrder = (stage.run as ReturnType<typeof vi.fn>).mock
        .invocationCallOrder[1];
      expect(resetOrder).toBeLessThan(reRunOrder);
    });

    it('keeps endpoint output when no dump is available to fall back to', async () => {
      const stage = makeStage('aggregate');
      vi.spyOn(stage, 'run').mockRejectedValue(
        new Error('endpoint killed the heavy query'),
      );
      const resolver = makeFallbackResolver();
      // No importable dump passed probing.
      resolver.resolveFallback.mockResolvedValue(
        new NoDistributionAvailable(dataset, 'No importable distributions', []),
      );
      const reporter = makeReporter();

      const pipeline = new Pipeline({
        datasetSelector: makeDatasetSelector(dataset),
        stages: [stage],
        writers: writer,
        distributionResolver: resolver,
        reporter,
      });

      await pipeline.run();

      expect(resolver.resolveFallback).toHaveBeenCalledTimes(1);
      // No re-run: the stage ran once and nothing was reset.
      expect(stage.run).toHaveBeenCalledTimes(1);
      expect(writer.reset).not.toHaveBeenCalled();
      expect(reporter.stageFailed).toHaveBeenCalledWith(
        'aggregate',
        expect.any(Error),
      );
    });

    it('does not fall back again when already running on an imported dump', async () => {
      // A stage that always fails, even on the imported dump.
      const stage = makeStage('aggregate');
      vi.spyOn(stage, 'run').mockRejectedValue(
        new Error('import is broken too'),
      );
      const resolver = makeFallbackResolver();
      // The dataset resolves directly to an already-imported dump.
      resolver.resolve = vi.fn(
        async () =>
          new ResolvedDistribution(importedDistribution, [], dumpDistribution),
      );

      const pipeline = new Pipeline({
        datasetSelector: makeDatasetSelector(dataset),
        stages: [stage],
        writers: writer,
        distributionResolver: resolver,
      });

      await pipeline.run();

      // An imported dump has no further fallback; resolveFallback is never tried.
      expect(resolver.resolveFallback).not.toHaveBeenCalled();
      expect(stage.run).toHaveBeenCalledTimes(1);
      expect(writer.reset).not.toHaveBeenCalled();
    });

    it('reports the import lifecycle of a successful fallback to the reporter', async () => {
      const stage = makeStage('aggregate');
      vi.spyOn(stage, 'run').mockImplementation(
        async (_dataset, distribution) => {
          if (distribution === endpointDistribution) {
            throw new Error('endpoint killed the heavy query');
          }
        },
      );
      const resolver = makeFallbackResolver();
      // The fallback import announces its start through the callbacks.
      resolver.resolveFallback.mockImplementation(
        async (_probed, callbacks?: ResolveCallbacks) => {
          callbacks?.onImportStart?.();
          return new ResolvedDistribution(
            importedDistribution,
            [],
            dumpDistribution,
          );
        },
      );
      const reporter = makeReporter();

      const pipeline = new Pipeline({
        datasetSelector: makeDatasetSelector(dataset),
        stages: [stage],
        writers: writer,
        distributionResolver: resolver,
        reporter,
      });

      await pipeline.run();

      expect(reporter.importStarted).toHaveBeenCalledTimes(1);
    });

    it('reports a failed fallback import to the reporter and keeps endpoint output', async () => {
      const stage = makeStage('aggregate');
      vi.spyOn(stage, 'run').mockRejectedValue(
        new Error('endpoint killed the heavy query'),
      );
      const resolver = makeFallbackResolver();
      // The dump import fails: announce it, then report no distribution.
      resolver.resolveFallback.mockImplementation(
        async (_probed, callbacks?: ResolveCallbacks) => {
          callbacks?.onImportStart?.();
          callbacks?.onImportFailed?.(dumpDistribution, 'Parse error');
          return new NoDistributionAvailable(dataset, 'Import failed', []);
        },
      );
      const reporter = makeReporter();

      const pipeline = new Pipeline({
        datasetSelector: makeDatasetSelector(dataset),
        stages: [stage],
        writers: writer,
        distributionResolver: resolver,
        reporter,
      });

      await pipeline.run();

      expect(reporter.importFailed).toHaveBeenCalledWith(
        dumpDistribution,
        'Parse error',
      );
      // Import failed → no re-run, endpoint output is kept.
      expect(stage.run).toHaveBeenCalledTimes(1);
      expect(writer.reset).not.toHaveBeenCalled();
    });

    it('resets every writer when fanning out to multiple writers', async () => {
      const stage = makeStage('aggregate');
      vi.spyOn(stage, 'run').mockImplementation(
        async (_dataset, distribution) => {
          if (distribution === endpointDistribution) {
            throw new Error('endpoint killed the heavy query');
          }
        },
      );
      const writerA = makeWriter();
      const writerB = makeWriter();
      const resolver = makeFallbackResolver();

      const pipeline = new Pipeline({
        datasetSelector: makeDatasetSelector(dataset),
        stages: [stage],
        writers: [writerA, writerB],
        distributionResolver: resolver,
      });

      await pipeline.run();

      expect(writerA.reset).toHaveBeenCalledWith(dataset);
      expect(writerB.reset).toHaveBeenCalledWith(dataset);
    });
  });

  describe('plugins', () => {
    const { namedNode, quad: q } = DataFactory;
    const extra = q(
      namedNode('http://example.org/extra'),
      namedNode('http://example.org/p'),
      namedNode('http://example.org/o'),
    );

    function realExecutor(quads: Quad[]) {
      return {
        async execute(): Promise<AsyncIterable<Quad> | NotSupported> {
          return (async function* () {
            yield* quads;
          })();
        },
      };
    }

    function collectingWriter(): Writer & { quads: Quad[] } {
      const quads: Quad[] = [];
      return {
        quads,
        async write(_dataset: Dataset, data: AsyncIterable<Quad>) {
          for await (const quad of data) {
            quads.push(quad);
          }
        },
      };
    }

    it('applies beforeStageWrite transform', async () => {
      const q1 = q(
        namedNode('http://example.org/s'),
        namedNode('http://example.org/p'),
        namedNode('http://example.org/o'),
      );
      const cw = collectingWriter();

      const plugin: PipelinePlugin = {
        name: 'test',
        beforeStageWrite: async function* (quads) {
          yield* quads;
          yield extra;
        },
      };

      const pipeline = new Pipeline({
        datasetSelector: makeDatasetSelector(makeDataset()),
        stages: [new Stage({ name: 'stage1', executors: realExecutor([q1]) })],
        writers: cw,
        plugins: [plugin],
        distributionResolver: makeResolver(makeResolvedDistribution()),
      });

      await pipeline.run();

      expect(cw.quads).toEqual([q1, extra]);
    });

    it('composes multiple beforeStageWrite plugins in order', async () => {
      const q1 = q(
        namedNode('http://example.org/s'),
        namedNode('http://example.org/p'),
        namedNode('http://example.org/o'),
      );
      const extra2 = q(
        namedNode('http://example.org/extra2'),
        namedNode('http://example.org/p'),
        namedNode('http://example.org/o'),
      );
      const cw = collectingWriter();

      const plugin1: PipelinePlugin = {
        name: 'first',
        beforeStageWrite: async function* (quads) {
          yield* quads;
          yield extra;
        },
      };

      const plugin2: PipelinePlugin = {
        name: 'second',
        beforeStageWrite: async function* (quads) {
          yield* quads;
          yield extra2;
        },
      };

      const pipeline = new Pipeline({
        datasetSelector: makeDatasetSelector(makeDataset()),
        stages: [new Stage({ name: 'stage1', executors: realExecutor([q1]) })],
        writers: cw,
        plugins: [plugin1, plugin2],
        distributionResolver: makeResolver(makeResolvedDistribution()),
      });

      await pipeline.run();

      expect(cw.quads).toEqual([q1, extra, extra2]);
    });

    it('does not wrap writer when plugins have no beforeStageWrite', async () => {
      const stage = makeStage('stage1');
      const plugin: PipelinePlugin = { name: 'noop' };

      const pipeline = new Pipeline({
        datasetSelector: makeDatasetSelector(dataset),
        stages: [stage],
        writers: writer,
        plugins: [plugin],
        distributionResolver: makeResolver(makeResolvedDistribution()),
      });

      await pipeline.run();

      // Stage receives the original writer (no TransformWriter wrapping).
      const usedWriter = (stage.run as ReturnType<typeof vi.fn>).mock
        .calls[0][2];
      expect(usedWriter).toBe(writer);
    });

    it('passes dataset to beforeStageWrite transform', async () => {
      const cw = collectingWriter();
      const ds = makeDataset('http://example.org/my-dataset');

      const plugin: PipelinePlugin = {
        name: 'dataset-aware',
        beforeStageWrite: async function* (quads, { dataset }) {
          yield* quads;
          yield q(
            namedNode(dataset.iri.toString()),
            namedNode('http://example.org/p'),
            namedNode('http://example.org/o'),
          );
        },
      };

      const pipeline = new Pipeline({
        datasetSelector: makeDatasetSelector(ds),
        stages: [new Stage({ name: 'stage1', executors: realExecutor([]) })],
        writers: cw,
        plugins: [plugin],
        distributionResolver: makeResolver(makeResolvedDistribution()),
      });

      await pipeline.run();

      expect(cw.quads).toHaveLength(1);
      expect(cw.quads[0].subject.value).toBe('http://example.org/my-dataset');
    });

    it('passes the stage name to beforeStageWrite transform', async () => {
      const seenStages: string[] = [];

      const plugin: PipelinePlugin = {
        name: 'stage-aware',
        beforeStageWrite: async function* (quads, { stage }) {
          seenStages.push(stage);
          yield* quads;
        },
      };

      const pipeline = new Pipeline({
        datasetSelector: makeDatasetSelector(makeDataset()),
        stages: [
          new Stage({ name: 'first', executors: realExecutor([]) }),
          new Stage({ name: 'second', executors: realExecutor([]) }),
        ],
        writers: collectingWriter(),
        plugins: [plugin],
        distributionResolver: makeResolver(makeResolvedDistribution()),
      });

      await pipeline.run();

      expect(seenStages).toEqual(['first', 'second']);
    });
  });

  describe('resolver cleanup', () => {
    it('calls resolver.cleanup after processing a dataset', async () => {
      const cleanup = vi.fn().mockResolvedValue(undefined);
      const resolver: DistributionResolver = {
        probe: vi.fn(
          async (probedDataset: Dataset) =>
            new ProbedDistributions(probedDataset, [], null),
        ),
        resolve: vi.fn().mockResolvedValue(makeResolvedDistribution()),
        cleanup,
      };

      const pipeline = new Pipeline({
        datasetSelector: makeDatasetSelector(dataset),
        stages: [makeStage('stage1')],
        writers: writer,
        distributionResolver: resolver,
      });

      await pipeline.run();

      expect(cleanup).toHaveBeenCalledTimes(1);
    });

    it('calls resolver.cleanup even when a stage throws', async () => {
      const cleanup = vi.fn().mockResolvedValue(undefined);
      const resolver: DistributionResolver = {
        probe: vi.fn(
          async (probedDataset: Dataset) =>
            new ProbedDistributions(probedDataset, [], null),
        ),
        resolve: vi.fn().mockResolvedValue(makeResolvedDistribution()),
        cleanup,
      };

      const failingStage = makeStage('failing');
      vi.spyOn(failingStage, 'run').mockRejectedValue(
        new Error('Stage failed'),
      );

      const pipeline = new Pipeline({
        datasetSelector: makeDatasetSelector(dataset),
        stages: [failingStage],
        writers: writer,
        distributionResolver: resolver,
      });

      await pipeline.run();

      expect(cleanup).toHaveBeenCalledTimes(1);
    });

    it('works when resolver has no cleanup method', async () => {
      const resolver: DistributionResolver = {
        probe: vi.fn(
          async (probedDataset: Dataset) =>
            new ProbedDistributions(probedDataset, [], null),
        ),
        resolve: vi.fn().mockResolvedValue(makeResolvedDistribution()),
      };

      const pipeline = new Pipeline({
        datasetSelector: makeDatasetSelector(dataset),
        stages: [makeStage('stage1')],
        writers: writer,
        distributionResolver: resolver,
      });

      await expect(pipeline.run()).resolves.toBeUndefined();
    });
  });

  describe('timeout', () => {
    it('passes a TimeoutPolicy instance to each stage.run', async () => {
      const stage = makeStage('stage1');

      const pipeline = new Pipeline({
        datasetSelector: makeDatasetSelector(dataset),
        stages: [stage],
        writers: writer,
        distributionResolver: makeResolver(makeResolvedDistribution()),
      });

      await pipeline.run();

      const call = (stage.run as ReturnType<typeof vi.fn>).mock.calls[0];
      const options = call[3];
      expect(options.timeout).toBeDefined();
      expect(typeof options.timeout.beforeRequest).toBe('function');
      expect(typeof options.timeout.afterRequest).toBe('function');
    });

    it('invokes the factory once per dataset', async () => {
      const factory = vi.fn().mockImplementation(() => ({
        beforeRequest: () => 300_000,
        afterRequest: vi.fn(),
      }));

      const datasetA = makeDataset('http://example.org/dataset-a');
      const datasetB = makeDataset('http://example.org/dataset-b');

      const pipeline = new Pipeline({
        datasetSelector: makeDatasetSelector(datasetA, datasetB),
        stages: [makeStage('stage1')],
        writers: writer,
        distributionResolver: makeResolver(makeResolvedDistribution()),
        timeout: factory,
      });

      await pipeline.run();

      expect(factory).toHaveBeenCalledTimes(2);
    });

    it('does not share state between datasets', async () => {
      const policies: unknown[] = [];
      const factory = vi.fn().mockImplementation(() => {
        const policy = {
          beforeRequest: () => 300_000,
          afterRequest: vi.fn(),
        };
        policies.push(policy);
        return policy;
      });

      const stage = makeStage('stage1');
      const datasetA = makeDataset('http://example.org/dataset-a');
      const datasetB = makeDataset('http://example.org/dataset-b');

      const pipeline = new Pipeline({
        datasetSelector: makeDatasetSelector(datasetA, datasetB),
        stages: [stage],
        writers: writer,
        distributionResolver: makeResolver(makeResolvedDistribution()),
        timeout: factory,
      });

      await pipeline.run();

      const runCalls = (stage.run as ReturnType<typeof vi.fn>).mock.calls;
      expect(runCalls[0][3].timeout).toBe(policies[0]);
      expect(runCalls[1][3].timeout).toBe(policies[1]);
      expect(policies[0]).not.toBe(policies[1]);
    });

    it('forwards onTighten/onRelax transitions to the reporter', async () => {
      const tightenEvent = {
        endpoint: new URL('http://example.org/sparql'),
        fromTimeoutMs: 300_000,
        toTimeoutMs: 10_000,
        consecutiveTimeouts: 2,
      };
      const relaxEvent = {
        endpoint: new URL('http://example.org/sparql'),
        fromTimeoutMs: 10_000,
        toTimeoutMs: 300_000,
        consecutiveTimeouts: 0,
      };
      const factory = vi.fn().mockImplementation(() => ({
        beforeRequest: () => 300_000,
        afterRequest: vi.fn(),
        subscribe(observer: {
          onTighten?: (event: unknown) => void;
          onRelax?: (event: unknown) => void;
        }) {
          // Fire one of each transition synchronously after subscription
          // so the test doesn't depend on stage timing.
          observer.onTighten?.(tightenEvent);
          observer.onRelax?.(relaxEvent);
          return vi.fn();
        },
      }));

      const reporter = makeReporter();
      const pipeline = new Pipeline({
        datasetSelector: makeDatasetSelector(dataset),
        stages: [makeStage('stage1')],
        writers: writer,
        distributionResolver: makeResolver(makeResolvedDistribution()),
        timeout: factory,
        reporter,
      });

      await pipeline.run();

      expect(reporter.timeoutTightened).toHaveBeenCalledWith(tightenEvent);
      expect(reporter.timeoutRelaxed).toHaveBeenCalledWith(relaxEvent);
    });
  });

  describe('provenance store gate', () => {
    // A data-dump source with a deterministic fingerprint, so a stored record
    // can be made to match (or not) the current run.
    const dumpDistribution = new Distribution(
      new URL('http://example.org/data.nt'),
      'application/n-triples',
    );
    const dumpProbe = new DataDumpProbeResult(
      'http://example.org/data.nt',
      new Response('', {
        status: 200,
        headers: {
          'Content-Length': '1000',
          'Last-Modified': 'Sat, 01 Jun 2024 00:00:00 GMT',
        },
      }),
      0,
    );
    const currentFingerprint = sourceFingerprint(dumpDistribution, dumpProbe);

    /** A resolver whose probe selects the data dump, then resolves/imports it. */
    function makeDumpResolver(
      resolveResult:
        | ResolvedDistribution
        | NoDistributionAvailable = new ResolvedDistribution(
        sparqlDistribution,
        [dumpProbe],
        dumpDistribution,
        1,
        100,
      ),
    ): DistributionResolver & {
      probe: ReturnType<typeof vi.fn>;
      resolve: ReturnType<typeof vi.fn>;
    } {
      return {
        probe: vi.fn(
          async (probedDataset: Dataset) =>
            new ProbedDistributions(probedDataset, [dumpProbe], {
              distribution: dumpDistribution,
              probeResult: dumpProbe,
            }),
        ),
        resolve: vi.fn(async () => resolveResult),
      };
    }

    function makeStore(stored: ProcessingRecord | null): ProvenanceStore & {
      get: ReturnType<typeof vi.fn>;
      set: ReturnType<typeof vi.fn>;
    } {
      return {
        get: vi.fn().mockResolvedValue(stored),
        set: vi.fn().mockResolvedValue(undefined),
      };
    }

    it('throws when a store is configured without a pipelineVersion', () => {
      expect(
        () =>
          new Pipeline({
            datasetSelector: makeDatasetSelector(dataset),
            stages: [makeStage('stage1')],
            writers: writer,
            distributionResolver: makeResolver(makeResolvedDistribution()),
            provenanceStore: makeStore(null),
          }),
      ).toThrow(
        'pipelineVersion is required when a provenanceStore is configured',
      );
    });

    it('skips an unchanged dataset before importing', async () => {
      const resolver = makeDumpResolver();
      const store = makeStore({
        sourceFingerprint: currentFingerprint,
        pipelineVersion: 'v1',
        generatedAt: '2026-06-01T00:00:00.000Z',
        status: 'success',
      });
      const stage = makeStage('stage1');
      const reporter = makeReporter();

      const pipeline = new Pipeline({
        datasetSelector: makeDatasetSelector(dataset),
        stages: [stage],
        writers: writer,
        distributionResolver: resolver,
        provenanceStore: store,
        pipelineVersion: 'v1',
        reporter,
      });

      await pipeline.run();

      // The decisive guarantee: gated out before the import/resolve phase.
      expect(resolver.probe).toHaveBeenCalledTimes(1);
      expect(resolver.resolve).not.toHaveBeenCalled();
      expect(stage.run).not.toHaveBeenCalled();
      expect(store.set).not.toHaveBeenCalled();
      expect(reporter.datasetSkipped).toHaveBeenCalledWith(
        dataset,
        'Unchanged since last run',
      );
    });

    it('reprocesses and records a dataset with no prior record', async () => {
      const resolver = makeDumpResolver();
      const store = makeStore(null);
      const stage = makeStage('stage1');

      const pipeline = new Pipeline({
        datasetSelector: makeDatasetSelector(dataset),
        stages: [stage],
        writers: writer,
        distributionResolver: resolver,
        provenanceStore: store,
        pipelineVersion: 'v1',
      });

      await pipeline.run();

      expect(resolver.resolve).toHaveBeenCalledTimes(1);
      expect(stage.run).toHaveBeenCalledTimes(1);
      expect(store.set).toHaveBeenCalledWith(
        dataset.iri,
        expect.objectContaining({
          sourceFingerprint: currentFingerprint,
          pipelineVersion: 'v1',
          status: 'success',
        }),
      );
    });

    it('reprocesses when the stored pipelineVersion differs', async () => {
      const resolver = makeDumpResolver();
      const store = makeStore({
        sourceFingerprint: currentFingerprint,
        pipelineVersion: 'v1',
        generatedAt: '2026-06-01T00:00:00.000Z',
        status: 'success',
      });
      const stage = makeStage('stage1');

      const pipeline = new Pipeline({
        datasetSelector: makeDatasetSelector(dataset),
        stages: [stage],
        writers: writer,
        distributionResolver: resolver,
        provenanceStore: store,
        pipelineVersion: 'v2', // rotated → full reprocess
      });

      await pipeline.run();

      expect(resolver.resolve).toHaveBeenCalledTimes(1);
      expect(stage.run).toHaveBeenCalledTimes(1);
      expect(store.set).toHaveBeenCalledWith(
        dataset.iri,
        expect.objectContaining({ pipelineVersion: 'v2', status: 'success' }),
      );
    });

    it('records a failed outcome when no distribution resolves', async () => {
      const resolver = makeDumpResolver(
        new NoDistributionAvailable(dataset, 'Import failed', [dumpProbe]),
      );
      const store = makeStore(null);

      const pipeline = new Pipeline({
        datasetSelector: makeDatasetSelector(dataset),
        stages: [makeStage('stage1')],
        writers: writer,
        distributionResolver: resolver,
        provenanceStore: store,
        pipelineVersion: 'v1',
      });

      await pipeline.run();

      expect(store.set).toHaveBeenCalledWith(
        dataset.iri,
        expect.objectContaining({
          sourceFingerprint: currentFingerprint,
          status: 'failed',
        }),
      );
    });

    it('surfaces an invalid deep validity verdict when a distribution fails to import', async () => {
      const resolver = makeDumpResolver(
        new NoDistributionAvailable(
          dataset,
          'Import failed',
          [dumpProbe],
          new ImportFailed(
            dumpDistribution,
            'QName not allowed for property: rdf:Description',
          ),
        ),
      );
      const reporter = makeReporter();

      const pipeline = new Pipeline({
        datasetSelector: makeDatasetSelector(dataset),
        stages: [makeStage('stage1')],
        writers: writer,
        distributionResolver: resolver,
        reporter,
        pipelineVersion: 'v1',
      });

      await pipeline.run();

      expect(reporter.distributionValidated).toHaveBeenCalledWith(
        dumpDistribution,
        {
          valid: false,
          reason: 'parse-error',
          message: 'QName not allowed for property: rdf:Description',
          validatedFingerprint: currentFingerprint,
          depth: 'deep',
        },
      );
    });

    it('surfaces a valid deep verdict when a distribution imports successfully', async () => {
      const resolver = makeDumpResolver(); // default: imports dumpDistribution, 100 triples
      const reporter = makeReporter();

      const pipeline = new Pipeline({
        datasetSelector: makeDatasetSelector(dataset),
        stages: [makeStage('stage1')],
        writers: writer,
        distributionResolver: resolver,
        reporter,
        pipelineVersion: 'v1',
      });

      await pipeline.run();

      expect(reporter.distributionValidated).toHaveBeenCalledWith(
        dumpDistribution,
        {
          valid: true,
          validatedFingerprint: currentFingerprint,
          depth: 'deep',
        },
      );
    });

    it('surfaces an empty deep verdict when an import yields no triples', async () => {
      const resolver = makeDumpResolver(
        new ResolvedDistribution(
          sparqlDistribution,
          [dumpProbe],
          dumpDistribution,
          1,
          0,
        ),
      );
      const reporter = makeReporter();

      const pipeline = new Pipeline({
        datasetSelector: makeDatasetSelector(dataset),
        stages: [makeStage('stage1')],
        writers: writer,
        distributionResolver: resolver,
        reporter,
        pipelineVersion: 'v1',
      });

      await pipeline.run();

      expect(reporter.distributionValidated).toHaveBeenCalledWith(
        dumpDistribution,
        {
          valid: false,
          reason: 'empty',
          validatedFingerprint: currentFingerprint,
          depth: 'deep',
        },
      );
    });

    it('surfaces a shallow verdict from a probe that detected invalid RDF', async () => {
      const ttl = new Distribution(
        new URL('http://example.org/probe.ttl'),
        'text/turtle',
      );
      const probeResult = new DataDumpProbeResult(
        'http://example.org/probe.ttl',
        new Response('', {
          status: 200,
          headers: { 'Content-Type': 'text/turtle', 'Content-Length': '500' },
        }),
        0,
        'Unexpected "." on line 3.',
      );
      const reporter = makeReporter();
      const resolver = makeResolver(makeResolvedDistribution(), [
        { distribution: ttl, result: probeResult },
      ]);

      const pipeline = new Pipeline({
        datasetSelector: makeDatasetSelector(dataset),
        stages: [makeStage('stage1')],
        writers: writer,
        distributionResolver: resolver,
        reporter,
        pipelineVersion: 'v1',
      });

      await pipeline.run();

      expect(reporter.distributionValidated).toHaveBeenCalledWith(ttl, {
        valid: false,
        reason: 'parse-error',
        message: 'Unexpected "." on line 3.',
        validatedFingerprint: sourceFingerprint(ttl, probeResult),
        depth: 'shallow',
      });
    });

    it('records the observed fingerprint on the reachability result', async () => {
      const reporter = makeReporter();
      const resolver = makeResolver(makeResolvedDistribution(), [
        { distribution: dumpDistribution, result: dumpProbe },
      ]);

      const pipeline = new Pipeline({
        datasetSelector: makeDatasetSelector(dataset),
        stages: [makeStage('stage1')],
        writers: writer,
        distributionResolver: resolver,
        reporter,
        pipelineVersion: 'v1',
      });

      await pipeline.run();

      expect(reporter.distributionProbed).toHaveBeenCalledWith(
        expect.objectContaining({
          distribution: dumpDistribution,
          fingerprint: currentFingerprint,
        }),
      );
    });

    it("records 'failed' when a stage throws", async () => {
      const resolver = makeDumpResolver();
      const store = makeStore(null);
      const failingStage = makeStage('failing');
      vi.spyOn(failingStage, 'run').mockRejectedValue(new Error('stage boom'));

      const pipeline = new Pipeline({
        datasetSelector: makeDatasetSelector(dataset),
        stages: [failingStage],
        writers: writer,
        distributionResolver: resolver,
        provenanceStore: store,
        pipelineVersion: 'v1',
      });

      await pipeline.run();

      // The dataset produced no output, so it must not be recorded as success.
      expect(store.set).toHaveBeenCalledWith(
        dataset.iri,
        expect.objectContaining({ status: 'failed' }),
      );
    });

    it('reprocesses without crashing when the store read fails', async () => {
      const resolver = makeDumpResolver();
      const store: ProvenanceStore & { get: ReturnType<typeof vi.fn> } = {
        get: vi.fn().mockRejectedValue(new Error('store unreachable')),
        set: vi.fn().mockResolvedValue(undefined),
      };
      const stage = makeStage('stage1');

      const pipeline = new Pipeline({
        datasetSelector: makeDatasetSelector(dataset),
        stages: [stage],
        writers: writer,
        distributionResolver: resolver,
        provenanceStore: store,
        pipelineVersion: 'v1',
      });

      // A store read failure must not abort the run; it falls through to
      // reprocessing rather than wrongly skipping or crashing.
      await expect(pipeline.run()).resolves.toBeUndefined();
      expect(resolver.resolve).toHaveBeenCalledTimes(1);
      expect(stage.run).toHaveBeenCalledTimes(1);
    });

    it('continues the run when the store write fails', async () => {
      const dataset1 = makeDataset('http://example.org/dataset/1');
      const dataset2 = makeDataset('http://example.org/dataset/2');
      const resolver = makeDumpResolver();
      const store: ProvenanceStore & { set: ReturnType<typeof vi.fn> } = {
        get: vi.fn().mockResolvedValue(null),
        set: vi.fn().mockRejectedValue(new Error('disk full')),
      };
      const stage = makeStage('stage1');

      const pipeline = new Pipeline({
        datasetSelector: makeDatasetSelector(dataset1, dataset2),
        stages: [stage],
        writers: writer,
        distributionResolver: resolver,
        provenanceStore: store,
        pipelineVersion: 'v1',
      });

      await expect(pipeline.run()).resolves.toBeUndefined();
      // Both datasets are processed despite each write throwing.
      expect(stage.run).toHaveBeenCalledTimes(2);
      expect(store.set).toHaveBeenCalledTimes(2);
    });

    it('does not gate or record when no store is configured', async () => {
      const resolver = makeDumpResolver();
      const stage = makeStage('stage1');

      const pipeline = new Pipeline({
        datasetSelector: makeDatasetSelector(dataset),
        stages: [stage],
        writers: writer,
        distributionResolver: resolver,
      });

      await pipeline.run();

      // Today's behaviour: always resolve and run.
      expect(resolver.resolve).toHaveBeenCalledTimes(1);
      expect(stage.run).toHaveBeenCalledTimes(1);
    });
  });

  describe('resolver phase errors', () => {
    it('skips a dataset and never resolves when probing throws', async () => {
      const resolver: DistributionResolver = {
        probe: vi.fn().mockRejectedValue(new Error('probe boom')),
        resolve: vi.fn(),
      };
      const stage = makeStage('stage1');
      const reporter = makeReporter();

      const pipeline = new Pipeline({
        datasetSelector: makeDatasetSelector(dataset),
        stages: [stage],
        writers: writer,
        distributionResolver: resolver,
        reporter,
      });

      await pipeline.run();

      expect(resolver.resolve).not.toHaveBeenCalled();
      expect(stage.run).not.toHaveBeenCalled();
      expect(reporter.datasetSkipped).toHaveBeenCalledWith(
        dataset,
        expect.stringContaining('Distribution probing failed'),
      );
    });

    it('skips a dataset when resolution throws', async () => {
      const resolver: DistributionResolver = {
        probe: vi.fn(
          async (probedDataset: Dataset) =>
            new ProbedDistributions(probedDataset, [], null),
        ),
        resolve: vi.fn().mockRejectedValue(new Error('resolve boom')),
      };
      const stage = makeStage('stage1');
      const reporter = makeReporter();

      const pipeline = new Pipeline({
        datasetSelector: makeDatasetSelector(dataset),
        stages: [stage],
        writers: writer,
        distributionResolver: resolver,
        reporter,
      });

      await pipeline.run();

      expect(stage.run).not.toHaveBeenCalled();
      expect(reporter.datasetSkipped).toHaveBeenCalledWith(
        dataset,
        expect.stringContaining('Distribution resolution failed'),
      );
    });
  });
});
