import { createReadStream } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { Dataset, Distribution } from '@lde/dataset';
import type { Quad } from '@rdfjs/types';
import { StreamParser } from 'n3';
import type { DatasetSelector } from './selector.js';
import { Stage } from './stage.js';
import type { QuadTransform } from './stage.js';
import type {
  DatasetOutcome,
  DatasetWriter,
  RunContext,
  RunWriter,
  Writer,
} from './writer/writer.js';
import { FileWriter } from './writer/fileWriter.js';
import {
  type DistributionResolver,
  type ProbedDistributions,
  NoDistributionAvailable,
  ResolvedDistribution,
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
import { ImportSuccessful } from '@lde/sparql-importer';
import {
  importOutcomeToVerdict,
  probeResultToVerdict,
} from '@lde/distribution-health';
import { NotSupported } from './sparql/reader.js';
import type { StageOutputResolver } from './stageOutputResolver.js';
import type {
  DistributionAnalysisResult,
  ProgressReporter,
} from './progressReporter.js';
import { combineReporters } from './combineReporters.js';
import type { Validator } from './validator.js';
import {
  ConstantTimeoutPolicy,
  type TimeoutPolicy,
} from './sparql/timeoutPolicy.js';

/**
 * Context handed to a {@link PipelinePlugin.beforeStageWrite} transform: the
 * `dataset` whose merged output is being written and the `stage` that produced
 * it. The stage identity lets a transform mint stable IRIs keyed on
 * `(dataset, stage)` instead of blank nodes, which would fuse across stages and
 * datasets once the per-dataset outputs are merged into one graph (see issue
 * #474).
 */
export interface BeforeStageWriteContext {
  dataset: Dataset;
  stage: string;
}

/** Plugin that hooks into pipeline lifecycle events. */
export interface PipelinePlugin {
  name: string;
  /**
   * Transform the merged, post-stage quad stream before writing (extension
   * point 2: pipeline-wide, post-merge). The home of cross-cutting concerns
   * – provenance, namespace normalisation – that apply regardless of which
   * reader produced a quad.
   */
  beforeStageWrite?: QuadTransform<BeforeStageWriteContext>;
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
  /**
   * Observer(s) notified of pipeline lifecycle events. Pass an array to have
   * several reporters observe the same run – e.g. a console reporter alongside
   * a verdict-collecting one; every reporter receives each event in array
   * order. A single reporter may be passed directly.
   */
  reporter?: ProgressReporter | readonly ProgressReporter[];
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

  async openRun(context: RunContext): Promise<RunWriter> {
    // Opening a writer's run can have side effects (a cross-pod lock, a fresh
    // collection). If one writer opens but a sibling then fails, the pipeline
    // never gets a RunWriter to abort, so roll the opened ones back here
    // before rethrowing — otherwise their locks and collections leak.
    const results = await Promise.allSettled(
      this.writers.map((writer) => writer.openRun(context)),
    );
    const opened = results.flatMap((result) =>
      result.status === 'fulfilled' ? [result.value] : [],
    );
    const failure = results.find(
      (result): result is PromiseRejectedResult => result.status === 'rejected',
    );
    if (failure) {
      await Promise.allSettled(opened.map((run) => run.abort(failure.reason)));
      throw failure.reason;
    }
    return new FanOutRunWriter(opened);
  }
}

/**
 * Run independent branch operations concurrently, giving every branch its
 * chance even when one fails; the first failure is rethrown afterwards.
 */
async function settleBranches(tasks: readonly Promise<void>[]): Promise<void> {
  const results = await Promise.allSettled(tasks);
  const failed = results.find(
    (result): result is PromiseRejectedResult => result.status === 'rejected',
  );
  if (failed) throw failed.reason;
}

class FanOutRunWriter implements RunWriter {
  constructor(private readonly runs: RunWriter[]) {}

  async write(dataset: Dataset, quads: AsyncIterable<Quad>): Promise<void> {
    const branches = tee(quads, this.runs.length);
    await Promise.all(
      this.runs.map((run, index) => run.write(dataset, branches[index])),
    );
  }

  async flush(dataset: Dataset, outcome: DatasetOutcome): Promise<void> {
    for (const run of this.runs) await run.flush?.(dataset, outcome);
  }

  async reset(dataset: Dataset): Promise<void> {
    for (const run of this.runs) await run.reset?.(dataset);
  }

  async commit(): Promise<void> {
    // Destinations are independent, so their commits (alias swaps, sweeps –
    // the slowest part of a run) need not queue behind each other.
    await settleBranches(this.runs.map((run) => run.commit()));
  }

  async abort(error: unknown): Promise<void> {
    // Abort every branch even when one abort fails: each destination must get
    // its chance to clean up.
    await settleBranches(this.runs.map((run) => run.abort(error)));
  }
}

class TransformWriter implements DatasetWriter {
  constructor(
    private readonly inner: DatasetWriter,
    private readonly transform: QuadTransform<BeforeStageWriteContext>,
    private readonly stage: string,
  ) {}

  async write(dataset: Dataset, quads: AsyncIterable<Quad>): Promise<void> {
    await this.inner.write(
      dataset,
      this.transform(quads, { dataset, stage: this.stage }),
    );
  }
  // Only write(): the Pipeline flushes the underlying run writer directly, once
  // per dataset after all stages — a TransformWriter only wraps a single write.
}

export class Pipeline {
  private readonly name: string;
  private readonly datasetSelector: DatasetSelector;
  private readonly stages: Stage[];
  private readonly writer: Writer;
  private readonly beforeStageWrite?: QuadTransform<BeforeStageWriteContext>;
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

    // The user writer is the post-merge target; the plugins' beforeStageWrite
    // transforms wrap it per stage (see stageWriter) so each carries the stage
    // identity it needs to mint stable, non-fusing IRIs.
    this.writer = Array.isArray(options.writers)
      ? new FanOutWriter(options.writers)
      : options.writers;

    const transforms = options.plugins
      ?.map((p) => p.beforeStageWrite)
      .filter(
        (t): t is QuadTransform<BeforeStageWriteContext> => t !== undefined,
      );
    this.beforeStageWrite = transforms?.length
      ? (quads, context) => transforms.reduce((q, fn) => fn(q, context), quads)
      : undefined;
    this.distributionResolver =
      options.distributionResolver ?? new SparqlDistributionResolver();
    this.chaining = options.chaining;
    // `Array.isArray` narrows the array branch but not the readonly-array out of
    // the else branch, so cast the single-reporter case explicitly.
    this.reporter = Array.isArray(options.reporter)
      ? combineReporters(options.reporter)
      : (options.reporter as ProgressReporter | undefined);
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

    // The run transaction: one openRun → write* → commit/abort per pipeline
    // run. `selectedSources` accumulates every selected dataset – including
    // ones skipped as unchanged – so a writer's commit can sweep by registry
    // membership.
    const selectedSources: string[] = [];
    const context: RunContext = {
      runId: randomUUID(),
      startedAt: new Date().toISOString(),
      selectedSources: () => selectedSources,
      provenance: this.provenanceStore,
    };
    const runWriter = await this.writer.openRun(context);

    try {
      for await (const dataset of datasets) {
        selectedSources.push(dataset.iri.toString());
        await this.processDataset(dataset, runWriter, context);
      }
      await runWriter.commit();
    } catch (error) {
      await runWriter.abort(error);
      throw error;
    }

    const finalMemory = process.memoryUsage();
    this.reporter?.pipelineComplete?.({
      duration: Date.now() - start,
      memoryUsageBytes: finalMemory.rss,
      heapUsedBytes: finalMemory.heapUsed,
    });
  }

  private async processDataset(
    dataset: Dataset,
    runWriter: RunWriter,
    context: RunContext,
  ): Promise<void> {
    this.reporter?.datasetStart?.(dataset);

    // Probe phase: gather probe results and the source-to-be, without importing.
    let probed: ProbedDistributions;
    try {
      probed = await this.distributionResolver.probe(dataset, {
        onProbe: (distribution, result) => {
          this.reporter?.distributionProbed?.(
            mapProbeResult(distribution, result),
          );
          // Shallow validity: the probe parse-validates small RDF bodies as a
          // by-product. Surface that verdict per distribution, judged against
          // the distribution's own observed fingerprint.
          const verdict = probeResultToVerdict(
            result,
            sourceFingerprint(distribution, result),
          );
          if (verdict) {
            this.reporter?.distributionValidated?.(distribution, verdict);
          }
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
    // Reassigned to the dump's fingerprint if a reactive fallback later imports
    // one, so change-detection can skip an unchanged dump on the next run.
    let fingerprint = probed.source
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
      // A failed import is a deep RDF-validity verdict on the distribution
      // attempted. Surface it per distribution even though the dataset produces
      // no summary, so an invalid distribution is recorded rather than silently
      // dropped.
      if (resolved.importFailed) {
        this.reporter?.distributionValidated?.(
          resolved.importFailed.distribution,
          importOutcomeToVerdict(resolved.importFailed, fingerprint),
        );
      }
      // Record the failure so a dataset whose source is unchanged is not
      // re-imported every run; it is retried at the next fingerprint change or
      // version rotation.
      await this.recordOutcome(dataset, fingerprint, 'failed');
      this.reporter?.datasetSkipped?.(dataset, resolved.message);
      return;
    }

    this.reportSelectedDistribution(dataset, resolved, fingerprint);

    const timeout: TimeoutPolicy = this.timeoutFactory();
    const unsubscribe = timeout.subscribe?.({
      onTighten: (event) => this.reporter?.timeoutTightened?.(event),
      onRelax: (event) => this.reporter?.timeoutRelaxed?.(event),
    });

    let stageFailed = false;
    try {
      stageFailed = await this.runStages(
        dataset,
        resolved.distribution,
        timeout,
        runWriter,
        context,
      );

      // Reactive fallback: an endpoint that passed probing but could not serve
      // the analysis stages is empirically incapable. Switch to the dataset’s
      // data dump and re-run all stages locally, discarding the
      // endpoint-sourced partial results. Only a live endpoint
      // (`importedFrom === undefined`) can fall back – a run already on an
      // imported dump has nowhere further to go.
      if (
        stageFailed &&
        resolved.importedFrom === undefined &&
        this.distributionResolver.resolveFallback
      ) {
        // A failing fallback import must abort only this dataset, never the
        // whole run – matching the per-dataset isolation of the primary resolve
        // path. The dataset stays recorded as failed (stageFailed is already
        // true) and processing continues with the next dataset.
        try {
          const fallback = await this.distributionResolver.resolveFallback(
            probed,
            {
              onImportStart: () => this.reporter?.importStarted?.(),
              onImportFailed: (distribution, error) =>
                this.reporter?.importFailed?.(distribution, error),
            },
          );
          if (fallback instanceof ResolvedDistribution) {
            // The dump is now the dataset's effective source: report it as
            // selected/validated and adopt its change fingerprint so the next
            // run can skip an unchanged dump (the endpoint's fingerprint is
            // null, which would force a re-import every run).
            if (fallback.importedFrom) {
              const dumpProbeResult = probed.probeResults.find(
                (result) =>
                  result.url === fallback.importedFrom!.accessUrl.toString(),
              );
              if (dumpProbeResult) {
                fingerprint = sourceFingerprint(
                  fallback.importedFrom,
                  dumpProbeResult,
                );
              }
            }
            this.reportSelectedDistribution(dataset, fallback, fingerprint);
            // Discard the endpoint-sourced partial output before the re-run so
            // the dump-sourced stats replace it rather than appending to it.
            await runWriter.reset?.(dataset);
            stageFailed = await this.runStages(
              dataset,
              fallback.distribution,
              timeout,
              runWriter,
              context,
            );
          } else if (fallback.importFailed) {
            // A failed dump import is a deep validity verdict on that dump –
            // surface it rather than silently keeping the endpoint's partial
            // output, matching the primary NoDistributionAvailable path.
            this.reporter?.distributionValidated?.(
              fallback.importFailed.distribution,
              importOutcomeToVerdict(fallback.importFailed, fingerprint),
            );
          }
        } catch (error) {
          this.reporter?.stageFailed?.(
            'reactive-dump-fallback',
            error instanceof Error ? error : new Error(String(error)),
          );
        }
      }
    } finally {
      await this.distributionResolver.cleanup?.();
      unsubscribe?.();
    }

    await runWriter.flush?.(dataset, stageFailed ? 'failed' : 'success');
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
   * The writer a stage's merged output is written through: the open run
   * wrapped with the plugins' {@link PipelinePlugin.beforeStageWrite}
   * transforms, carrying this `stage`'s identity so a transform can mint stable
   * per-`(dataset, stage)` IRIs rather than blank nodes.
   */
  private stageWriter(runWriter: RunWriter, stage: string): DatasetWriter {
    return this.beforeStageWrite
      ? new TransformWriter(runWriter, this.beforeStageWrite, stage)
      : runWriter;
  }

  /**
   * Report a resolved distribution as the dataset's selected source, plus its
   * deep validity verdict when it was imported. Shared by the primary resolve
   * path and the reactive dump fallback so both surface the same reporter
   * events for the source they actually use. A completed data-dump import is a
   * deep validity verdict on the imported distribution (valid, or empty when it
   * yielded no triples); native SPARQL endpoints are not imported and carry no
   * deep verdict.
   */
  private reportSelectedDistribution(
    dataset: Dataset,
    resolved: ResolvedDistribution,
    fingerprint: string | null,
  ): void {
    this.reporter?.distributionSelected?.(
      dataset,
      resolved.distribution,
      resolved.importedFrom,
      resolved.importDuration,
      resolved.tripleCount,
    );

    if (resolved.importedFrom) {
      this.reporter?.distributionValidated?.(
        resolved.importedFrom,
        importOutcomeToVerdict(
          new ImportSuccessful(
            resolved.importedFrom,
            undefined,
            resolved.tripleCount,
          ),
          fingerprint,
        ),
      );
    }
  }

  /**
   * Run every top-level stage against one distribution, catching and reporting
   * per-stage failures so one failing stage does not abort the rest. Returns
   * whether any stage hard-failed – the signal the reactive dump fallback
   * reacts to.
   */
  private async runStages(
    dataset: Dataset,
    distribution: Distribution,
    timeout: TimeoutPolicy,
    runWriter: RunWriter,
    context: RunContext,
  ): Promise<boolean> {
    let stageFailed = false;
    for (const stage of this.stages) {
      try {
        if (stage.stages.length > 0) {
          await this.runChain(
            dataset,
            distribution,
            stage,
            runWriter,
            context,
            timeout,
          );
        } else {
          await this.runStage(
            dataset,
            distribution,
            stage,
            this.stageWriter(runWriter, stage.name),
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
    return stageFailed;
  }

  /**
   * Run a stage with reporting and return whether it was supported.
   * Returns `true` if the stage produced results, `false` if NotSupported.
   */
  private async runStage(
    dataset: Dataset,
    distribution: Distribution,
    stage: Stage,
    writer: DatasetWriter,
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
    writer: DatasetWriter,
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
    runWriter: RunWriter,
    context: RunContext,
    timeout?: TimeoutPolicy,
  ): Promise<void> {
    const { stageOutputResolver, outputDir } = this.chaining!;
    const outputFiles: string[] = [];

    // Run one chained stage into its scratch FileWriter and flush it, so the
    // output file exists on its final path before the resolver reads it. The
    // scratch run is bracketed like any other: committed on success, aborted
    // on failure so no half-written temp file is left behind.
    const runScratchStage = async (
      chainedStage: Stage,
      stageDistribution: Distribution,
    ): Promise<string> => {
      const scratchWriter = new FileWriter({
        outputDir: `${outputDir}/${chainedStage.name}`,
        format: 'n-triples',
      });
      const scratchRun = await scratchWriter.openRun(context);
      try {
        await this.runChainedStage(
          dataset,
          stageDistribution,
          chainedStage,
          scratchRun,
          timeout,
        );
        await scratchRun.flush(dataset, 'success');
        await scratchRun.commit();
      } catch (error) {
        await scratchRun.abort(error);
        throw error;
      }
      return scratchWriter.getOutputPath(dataset);
    };

    try {
      // 1. Run parent stage → scratch FileWriter.
      const parentOutput = await runScratchStage(stage, distribution);
      outputFiles.push(parentOutput);

      // 2. Chain through children.
      let currentDistribution = await stageOutputResolver.resolve(parentOutput);
      for (let i = 0; i < stage.stages.length; i++) {
        const childOutput = await runScratchStage(
          stage.stages[i],
          currentDistribution,
        );
        outputFiles.push(childOutput);

        if (i < stage.stages.length - 1) {
          currentDistribution = await stageOutputResolver.resolve(childOutput);
        }
      }

      // 3. Concatenate all output files → the open run, applying the plugins'
      // beforeStageWrite transforms once for the chain under the parent stage.
      await this.stageWriter(runWriter, stage.name).write(
        dataset,
        this.readFiles(outputFiles),
      );
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
  const fingerprint = sourceFingerprint(distribution, result);
  if (result instanceof NetworkError) {
    return {
      distribution,
      type: 'network-error' as const,
      available: false,
      error: result.message,
      warnings: [],
      fingerprint,
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
    fingerprint,
  };
}
