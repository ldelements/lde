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
} from './distribution/probe.js';
import { NotSupported } from './sparql/executor.js';
import type { StageOutputResolver } from './stageOutputResolver.js';
import type {
  DistributionAnalysisResult,
  ProgressReporter,
} from './progressReporter.js';

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
}

class FanOutWriter implements Writer {
  constructor(private readonly writers: Writer[]) {}

  async write(dataset: Dataset, quads: AsyncIterable<Quad>): Promise<void> {
    const collected: Quad[] = [];
    for await (const quad of quads) collected.push(quad);
    for (const w of this.writers) {
      await w.write(
        dataset,
        (async function* () {
          yield* collected;
        })(),
      );
    }
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

    this.reporter?.pipelineComplete?.({ duration: Date.now() - start });
  }

  private async processDataset(dataset: Dataset): Promise<void> {
    this.reporter?.datasetStart?.(dataset);

    const resolved = await this.distributionResolver.resolve(dataset, {
      onProbe: (distribution, result) => {
        this.reporter?.distributionProbed?.(
          mapProbeResult(distribution, result),
        );
      },
      onImportFailed: (distribution, error) => {
        this.reporter?.importFailed?.(distribution, error);
      },
    });

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
            await this.runChain(dataset, resolved.distribution, stage);
          } else {
            await this.runStage(dataset, resolved.distribution, stage);
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
    }

    await this.writer.flush?.(dataset);
    this.reporter?.datasetComplete?.(dataset);
  }

  private async runStage(
    dataset: Dataset,
    distribution: Distribution,
    stage: Stage,
  ): Promise<void> {
    this.reporter?.stageStart?.(stage.name);
    const stageStart = Date.now();

    let itemsProcessed = 0;
    let quadsGenerated = 0;

    const result = await stage.run(dataset, distribution, this.writer, {
      onProgress: (items, quads) => {
        itemsProcessed = items;
        quadsGenerated = quads;
        this.reporter?.stageProgress?.({ itemsProcessed, quadsGenerated });
      },
    });

    if (result instanceof NotSupported) {
      this.reporter?.stageSkipped?.(stage.name, result.message);
    } else {
      this.reporter?.stageComplete?.(stage.name, {
        itemsProcessed,
        quadsGenerated,
        duration: Date.now() - stageStart,
      });
    }
  }

  private async runChain(
    dataset: Dataset,
    distribution: Distribution,
    stage: Stage,
  ): Promise<void> {
    const { stageOutputResolver, outputDir } = this.chaining!;
    const outputFiles: string[] = [];

    try {
      // 1. Run parent stage → FileWriter.
      const parentWriter = new FileWriter({
        outputDir: `${outputDir}/${stage.name}`,
        format: 'n-triples',
      });

      await this.runChainedStage(dataset, distribution, stage, parentWriter);
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

  private async runChainedStage(
    dataset: Dataset,
    distribution: Distribution,
    stage: Stage,
    stageWriter: FileWriter,
  ): Promise<void> {
    this.reporter?.stageStart?.(stage.name);
    const stageStart = Date.now();

    let itemsProcessed = 0;
    let quadsGenerated = 0;

    const result = await stage.run(dataset, distribution, stageWriter, {
      onProgress: (items, quads) => {
        itemsProcessed = items;
        quadsGenerated = quads;
        this.reporter?.stageProgress?.({ itemsProcessed, quadsGenerated });
      },
    });

    if (result instanceof NotSupported) {
      this.reporter?.stageSkipped?.(stage.name, result.message);
      throw new Error(
        `Stage '${stage.name}' returned NotSupported in chained mode`,
      );
    }

    this.reporter?.stageComplete?.(stage.name, {
      itemsProcessed,
      quadsGenerated,
      duration: Date.now() - stageStart,
    });
  }

  private async *readFiles(paths: string[]): AsyncIterable<Quad> {
    for (const path of paths) {
      const stream = createReadStream(path);
      const parser = new StreamParser();
      stream.pipe(parser);
      for await (const quad of parser) {
        yield quad as Quad;
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
  };
}
