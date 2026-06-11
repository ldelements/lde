import { createReadStream } from 'node:fs';
import { Dataset, Distribution } from '@lde/dataset';
import type { Quad } from '@rdfjs/types';
import { StreamParser } from 'n3';
import type { DatasetSelector } from './selector.js';
import { Stage } from './stage.js';
import type { QuadTransform } from './stage.js';
import type { Writer } from './writer/writer.js';
import { FileWriter } from './writer/fileWriter.js';
import {
  type DistributionResolver,
  type ProbedDistributions,
  NoDistributionAvailable,
} from './distribution/resolver.js';
import { SparqlDistributionResolver } from './distribution/index.js';
import { sourceFingerprint } from './provenance/sourceFingerprint.js';
import { shouldReprocess } from './provenance/reprocessDecision.js';
import type { ProcessingRecord } from './provenance/record.js';
import type { ProvenanceStore } from './provenance/store.js';
import {
  NetworkError,
  SparqlProbeResult,
  type ProbeResultType,
} from '@lde/distribution-probe';
import { NotSupported } from './sparql/executor.js';
import type { StageOutputResolver } from './stageOutputResolver.js';
import type {
  DistributionAnalysisResult,
  ProgressReporter,
} from './progressReporter.js';
import type { Validator } from './validator.js';
import {
  ConstantTimeoutPolicy,
  type TimeoutPolicy,
} from './sparql/timeoutPolicy.js';

/** Plugin that hooks into pipeline lifecycle events. */
export interface PipelinePlugin {
  name: string;
  /**
   * Transform the merged, post-stage quad stream before writing (extension
   * point 2: pipeline-wide, post-merge). The home of cross-cutting concerns
   * – provenance, namespace normalisation – that apply regardless of which
   * executor produced a quad.
   */
  beforeStageWrite?: QuadTransform<{ dataset: Dataset }>;
}

export interface PipelineOptions {
  datasetSelector: DatasetSelector;
  stages: Stage[];
  writers: Writer | Writer[];
  plugins?: PipelinePlugin[];
  name?: string;
  distributionResolver?: DistributionResolver;
  chaining?: {
    stageOutputResolver: StageOutputResolver;
    outputDir: string;
  };
  reporter?: ProgressReporter;
  /**
   * Optional per-dataset processing memory. When set, the pipeline skips a
   * dataset whose source-change fingerprint and {@link pipelineVersion} both
   * match the stored record – before paying the import cost – and writes an
   * updated record after processing. When omitted, every dataset is
   * reprocessed (today’s behaviour).
   */
  provenanceStore?: ProvenanceStore;
  /**
   * Opaque, consumer-declared version of the pipeline’s output-affecting
   * logic, rotated only on releases that change output. Compared for equality,
   * never parsed or ordered. Required when {@link provenanceStore} is set (a
   * skip-enabled pipeline with no version would silently freeze); ignored
   * otherwise.
   */
  pipelineVersion?: string;
  /**
   * Factory producing a fresh {@link TimeoutPolicy} per dataset. Defaults
   * to {@link constantTimeoutPolicy}`(300_000)` so existing call sites
   * keep today’s 5-minute fixed budget.
   *
   * Use {@link adaptiveTimeoutPolicy} to fast-fail stages on endpoints
   * that have shown a run of consecutive timeouts. State is per
   * {@link TimeoutPolicy} instance, and the Pipeline invokes the factory
   * once per dataset so state resets between datasets.
   */
  timeout?: () => TimeoutPolicy;
}

/**
 * Split an async iterable into `count` branches that can be consumed
 * independently. Backpressure is enforced by the slowest consumer –
 * the source only advances once every branch has consumed the current item.
 */
function tee<T>(source: AsyncIterable<T>, count: number): AsyncIterable<T>[] {
  const iterator = source[Symbol.asyncIterator]();
  let current: Promise<IteratorResult<T>> | undefined;
  const consumed = new Array<boolean>(count).fill(false);
  const waiting: (() => void)[] = [];

  function advance(branch: number): Promise<IteratorResult<T>> {
    // First branch to request a new round fetches from the source.
    if (!current || consumed.every(Boolean)) {
      consumed.fill(false);
      current = iterator.next();
    }

    // This branch already consumed the current item – wait for the next round.
    if (consumed[branch]) {
      return new Promise<void>((resolve) => waiting.push(resolve)).then(() =>
        advance(branch),
      );
    }

    consumed[branch] = true;

    // All branches consumed – wake up any that are waiting for the next round.
    if (consumed.every(Boolean)) {
      for (const resolve of waiting.splice(0)) resolve();
    }

    return current;
  }

  return Array.from({ length: count }, (_, index) => ({
    [Symbol.asyncIterator](): AsyncIterator<T> {
      return {
        async next() {
          return advance(index);
        },
      };
    },
  }));
}

class FanOutWriter implements Writer {
  constructor(private readonly writers: Writer[]) {}

  async write(dataset: Dataset, quads: AsyncIterable<Quad>): Promise<void> {
    const branches = tee(quads, this.writers.length);
    await Promise.all(
      this.writers.map((writer, index) =>
        writer.write(dataset, branches[index]),
      ),
    );
  }

  async flush(dataset: Dataset): Promise<void> {
    for (const w of this.writers) await w.flush?.(dataset);
  }
}

class TransformWriter implements Writer {
  constructor(
    private readonly inner: Writer,
    private readonly transform: QuadTransform<{ dataset: Dataset }>,
  ) {}

  async write(dataset: Dataset, quads: AsyncIterable<Quad>): Promise<void> {
    await this.inner.write(dataset, this.transform(quads, { dataset }));
  }

  async flush(dataset: Dataset): Promise<void> {
    await this.inner.flush?.(dataset);
  }
}

export class Pipeline {
  private readonly name: string;
  private readonly datasetSelector: DatasetSelector;
  private readonly stages: Stage[];
  private readonly writer: Writer;
  private readonly distributionResolver: DistributionResolver;
  private readonly chaining?: PipelineOptions['chaining'];
  private readonly reporter?: ProgressReporter;
  private readonly timeoutFactory: () => TimeoutPolicy;
  private readonly provenanceStore?: ProvenanceStore;
  private readonly pipelineVersion?: string;

  constructor(options: PipelineOptions) {
    const hasSubStages = options.stages.some(
      (stage) => stage.stages.length > 0,
    );
    if (hasSubStages && !options.chaining) {
      throw new Error('chaining is required when any stage has sub-stages');
    }

    if (options.provenanceStore && options.pipelineVersion === undefined) {
      throw new Error(
        'pipelineVersion is required when a provenanceStore is configured',
      );
    }

    this.name = options.name ?? '';
    this.datasetSelector = options.datasetSelector;
    this.stages = options.stages;

    let writer: Writer = Array.isArray(options.writers)
      ? new FanOutWriter(options.writers)
      : options.writers;

    const transforms = options.plugins
      ?.map((p) => p.beforeStageWrite)
      .filter((t): t is QuadTransform<{ dataset: Dataset }> => t !== undefined);
    if (transforms?.length) {
      const composed: QuadTransform<{ dataset: Dataset }> = (quads, context) =>
        transforms.reduce((q, fn) => fn(q, context), quads);
      writer = new TransformWriter(writer, composed);
    }

    this.writer = writer;
    this.distributionResolver =
      options.distributionResolver ?? new SparqlDistributionResolver();
    this.chaining = options.chaining;
    this.reporter = options.reporter;
    this.timeoutFactory =
      options.timeout ?? (() => new ConstantTimeoutPolicy(300_000));
    this.provenanceStore = options.provenanceStore;
    this.pipelineVersion = options.pipelineVersion;
  }

  async run(): Promise<void> {
    const start = Date.now();

    this.reporter?.pipelineStart?.(this.name);

    const selectStart = Date.now();
    const datasets = await this.datasetSelector.select();
    this.reporter?.datasetsSelected?.(datasets.total, Date.now() - selectStart);
    for await (const dataset of datasets) {
      await this.processDataset(dataset);
    }

    const finalMemory = process.memoryUsage();
    this.reporter?.pipelineComplete?.({
      duration: Date.now() - start,
      memoryUsageBytes: finalMemory.rss,
      heapUsedBytes: finalMemory.heapUsed,
    });
  }

  private async processDataset(dataset: Dataset): Promise<void> {
    this.reporter?.datasetStart?.(dataset);

    // Probe phase: gather probe results and the source-to-be, without importing.
    let probed: ProbedDistributions;
    try {
      probed = await this.distributionResolver.probe(dataset, {
        onProbe: (distribution, result) => {
          this.reporter?.distributionProbed?.(
            mapProbeResult(distribution, result),
          );
        },
      });
    } catch (error) {
      this.reporter?.datasetSkipped?.(
        dataset,
        `Distribution probing failed: ${error instanceof Error ? error.message : String(error)}`,
      );
      return;
    }

    // Derive the source-change fingerprint from the probed source: null for a
    // live SPARQL endpoint (always reprocess) or when no source is available.
    const fingerprint = probed.source
      ? sourceFingerprint(probed.source.distribution, probed.source.probeResult)
      : null;

    // Gate: skip an unchanged dataset before paying any import cost.
    if (this.provenanceStore) {
      let stored: ProcessingRecord | null = null;
      try {
        stored = await this.provenanceStore.get(dataset.iri);
      } catch {
        // An unreadable record must not abort the whole run, nor wrongly skip:
        // treat it as ‘never processed’ so this dataset reprocesses. The
        // periodic full reprocess is the backstop.
        stored = null;
      }
      if (
        !shouldReprocess(
          {
            sourceFingerprint: fingerprint,
            pipelineVersion: this.pipelineVersion!,
          },
          stored,
        )
      ) {
        this.reporter?.datasetSkipped?.(dataset, 'Unchanged since last run');
        return;
      }
    }

    // Resolve phase: import a data dump only when the source is one.
    let resolved;
    try {
      resolved = await this.distributionResolver.resolve(probed, {
        onImportStart: () => {
          this.reporter?.importStarted?.();
        },
        onImportFailed: (distribution, error) => {
          this.reporter?.importFailed?.(distribution, error);
        },
      });
    } catch (error) {
      this.reporter?.datasetSkipped?.(
        dataset,
        `Distribution resolution failed: ${error instanceof Error ? error.message : String(error)}`,
      );
      return;
    }

    if (resolved instanceof NoDistributionAvailable) {
      // Record the failure so a dataset whose source is unchanged is not
      // re-imported every run; it is retried at the next fingerprint change or
      // version rotation.
      await this.recordOutcome(dataset, fingerprint, 'failed');
      this.reporter?.datasetSkipped?.(dataset, resolved.message);
      return;
    }

    this.reporter?.distributionSelected?.(
      dataset,
      resolved.distribution,
      resolved.importedFrom,
      resolved.importDuration,
      resolved.tripleCount,
    );

    const timeout: TimeoutPolicy = this.timeoutFactory();
    const unsubscribe = timeout.subscribe?.({
      onTighten: (event) => this.reporter?.timeoutTightened?.(event),
      onRelax: (event) => this.reporter?.timeoutRelaxed?.(event),
    });

    let stageFailed = false;
    try {
      for (const stage of this.stages) {
        try {
          if (stage.stages.length > 0) {
            await this.runChain(dataset, resolved.distribution, stage, timeout);
          } else {
            await this.runStage(
              dataset,
              resolved.distribution,
              stage,
              this.writer,
              timeout,
            );
          }
        } catch (error) {
          stageFailed = true;
          this.reporter?.stageFailed?.(
            stage.name,
            error instanceof Error ? error : new Error(String(error)),
          );
        }
      }
    } finally {
      await this.distributionResolver.cleanup?.();
      unsubscribe?.();
    }

    await this.writer.flush?.(dataset);
    await this.reportValidators(dataset);
    // A dataset whose stages threw produced incomplete output; record it as
    // ‘failed’ rather than freezing a broken result under a ‘success’ record.
    await this.recordOutcome(
      dataset,
      fingerprint,
      stageFailed ? 'failed' : 'success',
    );
    const datasetMemory = process.memoryUsage();
    this.reporter?.datasetComplete?.(dataset, {
      memoryUsageBytes: datasetMemory.rss,
      heapUsedBytes: datasetMemory.heapUsed,
    });
  }

  /** Persist the processing record for a dataset, when a store is configured. */
  private async recordOutcome(
    dataset: Dataset,
    fingerprint: string | null,
    status: ProcessingRecord['status'],
  ): Promise<void> {
    if (!this.provenanceStore) return;
    try {
      await this.provenanceStore.set(dataset.iri, {
        sourceFingerprint: fingerprint,
        pipelineVersion: this.pipelineVersion!,
        generatedAt: new Date().toISOString(),
        status,
      });
    } catch {
      // A failed write must not abort the run; the dataset simply reprocesses
      // next run, its record not yet updated.
    }
  }

  private async reportValidators(dataset: Dataset): Promise<void> {
    const validators = new Set<Validator>();
    for (const stage of this.collectStages(this.stages)) {
      if (stage.validator) validators.add(stage.validator);
    }
    for (const validator of validators) {
      const report = await validator.report(dataset);
      this.reporter?.datasetValidated?.(dataset, report);
    }
  }

  private *collectStages(stages: readonly Stage[]): Iterable<Stage> {
    for (const stage of stages) {
      yield stage;
      if (stage.stages.length > 0) yield* this.collectStages(stage.stages);
    }
  }

  /**
   * Run a stage with reporting and return whether it was supported.
   * Returns `true` if the stage produced results, `false` if NotSupported.
   */
  private async runStage(
    dataset: Dataset,
    distribution: Distribution,
    stage: Stage,
    writer: Writer = this.writer,
    timeout?: TimeoutPolicy,
  ): Promise<boolean> {
    this.reporter?.stageStart?.(stage.name);
    const stageStart = Date.now();

    let itemsProcessed = 0;
    let quadsGenerated = 0;

    const result = await stage.run(dataset, distribution, writer, {
      onProgress: (items, quads) => {
        itemsProcessed = items;
        quadsGenerated = quads;
        const stageMemory = process.memoryUsage();
        this.reporter?.stageProgress?.({
          itemsProcessed,
          quadsGenerated,
          memoryUsageBytes: stageMemory.rss,
          heapUsedBytes: stageMemory.heapUsed,
        });
      },
      timeout,
    });

    if (result instanceof NotSupported) {
      this.reporter?.stageSkipped?.(stage.name, result.message);
      return false;
    }

    this.reporter?.stageComplete?.(stage.name, {
      itemsProcessed,
      quadsGenerated,
      duration: Date.now() - stageStart,
    });

    return true;
  }

  /** Run a stage in chained mode, throwing if the stage is not supported. */
  private async runChainedStage(
    dataset: Dataset,
    distribution: Distribution,
    stage: Stage,
    writer: Writer,
    timeout?: TimeoutPolicy,
  ): Promise<void> {
    const supported = await this.runStage(
      dataset,
      distribution,
      stage,
      writer,
      timeout,
    );
    if (!supported) {
      throw new Error(
        `Stage '${stage.name}' returned NotSupported in chained mode`,
      );
    }
  }

  private async runChain(
    dataset: Dataset,
    distribution: Distribution,
    stage: Stage,
    timeout?: TimeoutPolicy,
  ): Promise<void> {
    const { stageOutputResolver, outputDir } = this.chaining!;
    const outputFiles: string[] = [];

    try {
      // 1. Run parent stage → FileWriter.
      const parentWriter = new FileWriter({
        outputDir: `${outputDir}/${stage.name}`,
        format: 'n-triples',
      });

      await this.runChainedStage(
        dataset,
        distribution,
        stage,
        parentWriter,
        timeout,
      );
      outputFiles.push(parentWriter.getOutputPath(dataset));

      // 2. Chain through children.
      let currentDistribution = await stageOutputResolver.resolve(
        parentWriter.getOutputPath(dataset),
      );
      for (let i = 0; i < stage.stages.length; i++) {
        const child = stage.stages[i];
        const childWriter = new FileWriter({
          outputDir: `${outputDir}/${child.name}`,
          format: 'n-triples',
        });

        await this.runChainedStage(
          dataset,
          currentDistribution,
          child,
          childWriter,
          timeout,
        );
        outputFiles.push(childWriter.getOutputPath(dataset));

        if (i < stage.stages.length - 1) {
          currentDistribution = await stageOutputResolver.resolve(
            childWriter.getOutputPath(dataset),
          );
        }
      }

      // 3. Concatenate all output files → user writer.
      await this.writer.write(dataset, this.readFiles(outputFiles));
    } finally {
      await stageOutputResolver.cleanup();
    }
  }

  private async *readFiles(paths: string[]): AsyncIterable<Quad> {
    for (const path of paths) {
      const stream = createReadStream(path);
      const parser = new StreamParser();
      stream.pipe(parser);
      try {
        for await (const quad of parser) {
          yield quad as Quad;
        }
      } finally {
        stream.destroy();
      }
    }
  }
}

function mapProbeResult(
  distribution: Distribution,
  result: ProbeResultType,
): DistributionAnalysisResult {
  if (result instanceof NetworkError) {
    return {
      distribution,
      type: 'network-error' as const,
      available: false,
      error: result.message,
      warnings: [],
    };
  }
  return {
    distribution,
    type:
      result instanceof SparqlProbeResult
        ? ('sparql' as const)
        : ('data-dump' as const),
    available: result.isSuccess(),
    statusCode: result.statusCode,
    error: result.failureReason ?? undefined,
    warnings: result.warnings,
  };
}
