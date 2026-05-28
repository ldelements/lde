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
  NoDistributionAvailable,
} from './distribution/resolver.js';
import { SparqlDistributionResolver } from './distribution/index.js';
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
  /** Transform the quad stream before writing. */
  beforeStageWrite?: QuadTransform;
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
   * Factory producing a fresh {@link TimeoutPolicy} per dataset. Defaults
   * to {@link constantTimeoutPolicy}`(300_000)` so existing call sites
   * keep today’s 5-minute fixed budget.
   *
   * Use {@link adaptiveTimeoutPolicy} to fast-fail stages on endpoints
   * that have shown a run of consecutive timeouts. State is per
   * {@link TimeoutPolicy} instance, and the Pipeline invokes the factory
   * once per dataset so state resets between datasets.
   */
  timeoutPolicy?: () => TimeoutPolicy;
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
    private readonly transform: QuadTransform,
  ) {}

  async write(dataset: Dataset, quads: AsyncIterable<Quad>): Promise<void> {
    await this.inner.write(dataset, this.transform(quads, dataset));
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
  private readonly timeoutPolicyFactory: () => TimeoutPolicy;

  constructor(options: PipelineOptions) {
    const hasSubStages = options.stages.some(
      (stage) => stage.stages.length > 0,
    );
    if (hasSubStages && !options.chaining) {
      throw new Error('chaining is required when any stage has sub-stages');
    }

    this.name = options.name ?? '';
    this.datasetSelector = options.datasetSelector;
    this.stages = options.stages;

    let writer: Writer = Array.isArray(options.writers)
      ? new FanOutWriter(options.writers)
      : options.writers;

    const transforms = options.plugins
      ?.map((p) => p.beforeStageWrite)
      .filter((t): t is QuadTransform => t !== undefined);
    if (transforms?.length) {
      const composed: QuadTransform = (quads, dataset) =>
        transforms.reduce((q, fn) => fn(q, dataset), quads);
      writer = new TransformWriter(writer, composed);
    }

    this.writer = writer;
    this.distributionResolver =
      options.distributionResolver ?? new SparqlDistributionResolver();
    this.chaining = options.chaining;
    this.reporter = options.reporter;
    this.timeoutPolicyFactory =
      options.timeoutPolicy ?? (() => new ConstantTimeoutPolicy(300_000));
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

    const timeoutPolicy = this.timeoutPolicyFactory();
    const unsubscribe = timeoutPolicy.subscribe?.({
      onTighten: (event) => this.reporter?.timeoutTightened?.(event),
      onRelax: (event) => this.reporter?.timeoutRelaxed?.(event),
    });

    let resolved;
    try {
      resolved = await this.distributionResolver.resolve(dataset, {
        onProbe: (distribution, result) => {
          this.reporter?.distributionProbed?.(
            mapProbeResult(distribution, result),
          );
        },
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

    try {
      for (const stage of this.stages) {
        try {
          if (stage.stages.length > 0) {
            await this.runChain(
              dataset,
              resolved.distribution,
              stage,
              timeoutPolicy,
            );
          } else {
            await this.runStage(
              dataset,
              resolved.distribution,
              stage,
              this.writer,
              timeoutPolicy,
            );
          }
        } catch (error) {
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
    const datasetMemory = process.memoryUsage();
    this.reporter?.datasetComplete?.(dataset, {
      memoryUsageBytes: datasetMemory.rss,
      heapUsedBytes: datasetMemory.heapUsed,
    });
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
    timeoutPolicy?: TimeoutPolicy,
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
      timeoutPolicy,
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
    timeoutPolicy?: TimeoutPolicy,
  ): Promise<void> {
    const supported = await this.runStage(
      dataset,
      distribution,
      stage,
      writer,
      timeoutPolicy,
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
    timeoutPolicy?: TimeoutPolicy,
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
        timeoutPolicy,
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
          timeoutPolicy,
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
