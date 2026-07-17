import { Dataset, Distribution } from '@lde/dataset';
import type { Quad } from '@rdfjs/types';
import type { Reader, VariableBindings } from './sparql/reader.js';
import { NotSupported } from './sparql/reader.js';
import type { TimeoutPolicy } from './sparql/timeoutPolicy.js';
import { batch } from './batch.js';
import type { Validator } from './validator.js';
import type { DatasetWriter } from './writer/writer.js';
import { AsyncQueue } from './asyncQueue.js';

/**
 * Transforms a quad stream, given the context of its extension point.
 *
 * Every pipeline extension is the same operation – intercept the quad stream,
 * `AsyncIterable<Quad> → AsyncIterable<Quad>` – differing only in *where* it
 * runs and the `Ctx` in scope. See
 * {@link https://github.com/ldelements/lde/blob/main/docs/decisions/0002-unify-pipeline-extension-on-quad-transforms.md | ADR 2}.
 */
export type QuadTransform<Ctx> = (
  quads: AsyncIterable<Quad>,
  context: Ctx,
) => AsyncIterable<Quad>;

/**
 * Context handed to a {@link QuadTransform} attached to a reader (extension
 * point 1: per-reader output, pre-merge).
 *
 * `distribution` gives the transform endpoint reach – it may fire its own
 * SPARQL queries – and `stage` carries the stage identity.
 */
export interface ReaderContext {
  dataset: Dataset;
  distribution: Distribution;
  stage: string;
}

/**
 * The pipeline's one type-changing seam: turn a root-complete batch of quads
 * into a stage's output items. The only extension point whose output is not
 * `Quad` – a quad enrichment is a {@link QuadTransform} attached to a reader
 * (extension point 1), which runs *before* this. See
 * {@link https://github.com/ldelements/lde/blob/main/docs/decisions/0013-project-inside-the-batch-per-root-type.md | ADR 13}.
 */
export type BatchTransform<Out> = (
  quads: readonly Quad[],
  context: BatchContext,
) => Iterable<Out> | AsyncIterable<Out>;

/**
 * Context handed to a {@link BatchTransform}: {@link ReaderContext} plus the
 * batch's selected roots. `bindings` are the item-selector rows the readers were
 * given as a `VALUES` block, so the batch is root-complete by construction – the
 * projection frames exactly these roots rather than discovering them.
 */
export interface BatchContext extends ReaderContext {
  bindings: readonly VariableBindings[];
}

/**
 * An {@link Reader} with zero or more {@link QuadTransform}s attached as data.
 *
 * The stage runner applies the transform(s) in order to **this reader's
 * output** before merging it with sibling readers. The window is one
 * `read()` call:
 *
 * - for a global stage that is the reader's complete output;
 * - for a per-class stage that is one batch – one class at `batchSize: 1`.
 *
 * Decorating a reader is therefore construction-time data, not a wrapping
 * class: the runner is the only code that delegates to the inner reader.
 */
export interface AttachedReader {
  reader: Reader;
  transform?: QuadTransform<ReaderContext> | QuadTransform<ReaderContext>[];
}

/** One or more readers, each optionally carrying attached transforms. */
export type StageReaders =
  | Reader
  | AttachedReader
  | (Reader | AttachedReader)[];

/** A reader paired with its attached transforms, normalised to an array. */
interface NormalizedReader {
  reader: Reader;
  transforms: QuadTransform<ReaderContext>[];
}

export interface StageOptions<Out = Quad> {
  name: string;
  readers: StageReaders;
  itemSelector?: ItemSelector;
  /**
   * Turn each root-complete batch into this stage's output items – the one seam
   * whose output type differs from `Quad` ({@link BatchTransform}). Requires
   * {@link StageOptions.itemSelector} (a batch only exists under a selector) and
   * forbids {@link StageOptions.stages} (a chained stage serializes to
   * N-Triples, which a projected item cannot). Omit for a plain quad stage.
   */
  project?: BatchTransform<Out>;
  /**
   * Capacity of the bounded queue funnelling this stage's concurrent batches
   * into the single write. The queue applies backpressure at this many items,
   * so it bounds memory – set it where the cost per item is large (a projected
   * document is far heavier than a quad). Only meaningful with an item selector.
   *
   * @default 128
   */
  queueCapacity?: number;
  /**
   * Maximum number of bindings per reader call.
   *
   * Also used as the selector's page size so that each paginated request
   * fills exactly one batch. A `LIMIT` clause in the selector query
   * overrides this for endpoints with hard result limits.
   *
   * @default 10
   */
  batchSize?: number;
  /**
   * Maximum concurrent in-flight SPARQL queries. Within each batch, all
   * readers run in parallel; the number of concurrent batches is
   * automatically reduced to `⌊maxConcurrency / readerCount⌋` so the
   * total query pressure stays within this limit.
   *
   * @default 10
   */
  maxConcurrency?: number;
  /** Child stages that chain off this stage's output. */
  stages?: Stage[];
  /**
   * Treat a supported stage that produces no quads as a hard failure (throws),
   * rather than a legitimately empty result.
   *
   * Set this for stages whose query must yield output – typically a scalar
   * aggregate such as `SELECT (COUNT(*) AS ?n)`, which always returns exactly
   * one row, so zero quads can only mean the endpoint truncated or aborted the
   * response (e.g. a timeout surfaced as an empty `HTTP 200`). The resulting
   * failure flows through the pipeline like any other hard stage failure,
   * triggering the reactive dump fallback when one is configured.
   *
   * Leave it `false` (default) for stages that may legitimately be empty, such
   * as class/property partitions of a dataset that lacks that structure.
   *
   * @default false
   */
  expectsOutput?: boolean;
  /** Optional validation of the combined quads produced by all readers per batch. */
  validation?: {
    validator: Validator;
    /** What to do when a batch fails validation. @default 'write' */
    onInvalid?: 'write' | 'skip' | 'halt';
  };
}

export interface RunOptions {
  onProgress?: (itemsProcessed: number, quadsGenerated: number) => void;
  /**
   * Per-dataset {@link TimeoutPolicy} threaded through to readers and
   * item selectors. The Pipeline owns lifecycle (factory invocation per
   * dataset), so a single policy instance covers all stages and child
   * stages within one dataset.
   */
  timeout?: TimeoutPolicy;
}

/** Options accepted by {@link ItemSelector.select}. */
export interface SelectOptions {
  /** Per-call timeout policy. */
  timeout?: TimeoutPolicy;
}

export class Stage<Out = Quad> {
  readonly name: string;
  readonly stages: readonly Stage[];
  /** Whether an empty result is treated as a hard failure. @see {@link StageOptions.expectsOutput} */
  readonly expectsOutput: boolean;
  private readonly readers: NormalizedReader[];
  private readonly itemSelector?: ItemSelector;
  private readonly batchSize: number;
  private readonly maxConcurrency: number;
  private readonly validation?: StageOptions<Out>['validation'];
  private readonly project?: BatchTransform<Out>;
  private readonly queueCapacity?: number;

  constructor(options: StageOptions<Out>) {
    if (options.project && !options.itemSelector) {
      throw new Error(
        `Stage '${options.name}': 'project' requires an 'itemSelector' – without one there is no batch to project, only the readers' whole output.`,
      );
    }
    if (options.project && (options.stages?.length ?? 0) > 0) {
      throw new Error(
        `Stage '${options.name}': 'project' cannot combine with chained 'stages' – a chained stage serializes to N-Triples, which a projected item cannot.`,
      );
    }
    this.name = options.name;
    this.stages = options.stages ?? [];
    this.readers = normalizeReaders(options.readers);
    this.itemSelector = options.itemSelector;
    this.batchSize = options.batchSize ?? 10;
    this.maxConcurrency = options.maxConcurrency ?? 10;
    this.validation = options.validation;
    this.expectsOutput = options.expectsOutput ?? false;
    this.project = options.project;
    this.queueCapacity = options.queueCapacity;
  }

  /** The validator for this stage, if configured. */
  get validator(): Validator | undefined {
    return this.validation?.validator;
  }

  async run(
    dataset: Dataset,
    distribution: Distribution,
    writer: DatasetWriter<Out>,
    options?: RunOptions,
  ): Promise<NotSupported | void> {
    const timeout = options?.timeout;
    if (this.itemSelector) {
      return this.runWithSelector(
        this.itemSelector.select(distribution, this.batchSize, {
          timeout,
        }),
        dataset,
        distribution,
        writer,
        options,
      );
    }

    const streams = await this.readAll(dataset, distribution, timeout);
    if (streams instanceof NotSupported) {
      return streams;
    }

    // The non-selector path has no batch, so `project` is forbidden here (the
    // constructor rejects `project` without an `itemSelector`). It therefore
    // only ever writes quads, and `Out` is `Quad` at runtime – tsc cannot see
    // that invariant, so the writer is narrowed once.
    const quadWriter = writer as unknown as DatasetWriter<Quad>;

    // Quads the readers produced (before any validation filtering); used to
    // enforce `expectsOutput` below.
    let produced = 0;

    if (this.validation) {
      const buffer: Quad[] = [];
      for (const stream of streams) {
        for await (const quad of stream) {
          buffer.push(quad);
        }
      }
      produced = buffer.length;
      const onInvalid = this.validation.onInvalid ?? 'write';
      if (onInvalid === 'write') {
        await Promise.all([
          quadWriter.write(
            dataset,
            (async function* () {
              yield* buffer;
            })(),
          ),
          this.validation.validator.validate(buffer, dataset),
        ]);
      } else {
        const accepted = await this.validateBuffer(buffer, dataset);
        if (accepted.length > 0) {
          await quadWriter.write(
            dataset,
            (async function* () {
              yield* accepted;
            })(),
          );
        }
      }
    } else if (this.expectsOutput) {
      // Only thread the per-quad counter through when the count is actually
      // needed; the default path stays a plain streaming write with no overhead.
      await quadWriter.write(
        dataset,
        countQuads(mergeStreams(streams), (count) => {
          produced = count;
        }),
      );
    } else {
      await quadWriter.write(dataset, mergeStreams(streams));
    }

    this.assertProduced(produced);
  }

  /**
   * Throw when {@link StageOptions.expectsOutput} is set but the stage produced
   * no quads – a supported-but-empty result that signals a truncated or aborted
   * endpoint response rather than a legitimately empty one.
   */
  private assertProduced(produced: number): void {
    if (this.expectsOutput && produced === 0) {
      throw new Error(`Stage '${this.name}' expected output but produced none`);
    }
  }

  private async runWithSelector(
    selector: AsyncIterable<VariableBindings>,
    dataset: Dataset,
    distribution: Distribution,
    writer: DatasetWriter<Out>,
    options?: RunOptions,
  ): Promise<NotSupported | void> {
    // Peek the first batch to detect an empty selector before starting the
    // writer (important because e.g. SparqlUpdateWriter does CLEAR GRAPH).
    const batches = batch(selector, this.batchSize);
    const iter = batches[Symbol.asyncIterator]();
    const first = await iter.next();
    if (first.done) {
      return new NotSupported('No items selected');
    }

    // Reconstruct a full iterable including the peeked first batch.
    const allBatches: AsyncIterable<VariableBindings[]> = (async function* () {
      yield first.value;
      // Continue yielding remaining batches from the same iterator.
      for (;;) {
        const next = await iter.next();
        if (next.done) break;
        yield next.value;
      }
    })();

    const queue = new AsyncQueue<Out>(this.queueCapacity);
    let itemsProcessed = 0;
    // Output items written this run. Equals quads written for a plain stage;
    // for a projecting stage it counts projected items (documents), one or more
    // – or fewer – per root, which is what `expectsOutput`/`onProgress` report.
    let quadsGenerated = 0;
    let hasResults = false;

    const onInvalid = this.validation?.onInvalid ?? 'write';
    const pendingValidations: Promise<unknown>[] = [];

    const dispatch = async () => {
      const inFlight = new Set<Promise<void>>();
      let firstError: unknown;

      // Divide maxConcurrency by reader count so the total concurrent
      // SPARQL queries stays at maxConcurrency (each batch runs all
      // readers in parallel).
      const maxConcurrentBatches = Math.max(
        1,
        Math.floor(this.maxConcurrency / this.readers.length),
      );

      const track = (promise: Promise<void>) => {
        const p = promise.then(
          () => {
            inFlight.delete(p);
          },
          (err: unknown) => {
            inFlight.delete(p);
            firstError ??= err;
          },
        );
        inFlight.add(p);
      };

      try {
        for await (const bindings of allBatches) {
          if (firstError) break;

          // Respect maxConcurrency: wait for a slot to open.
          if (inFlight.size >= maxConcurrentBatches) {
            await Promise.race(inFlight);
            if (firstError) break;
          }

          track(
            (async () => {
              // Run all readers for this batch in parallel.
              const readerOutputs = await Promise.all(
                this.readers.map(async ({ reader, transforms }) => {
                  const result = await reader.read(dataset, distribution, {
                    bindings,
                    timeout: options?.timeout,
                  });
                  if (result instanceof NotSupported) return [];
                  hasResults = true;
                  const stream = this.applyTransforms(
                    transforms,
                    result,
                    dataset,
                    distribution,
                  );
                  const quads: Quad[] = [];
                  for await (const quad of stream) {
                    quads.push(quad);
                  }
                  return quads;
                }),
              );
              const batchQuads = readerOutputs.flat();

              // Validation runs on the quads, before projection – validators are
              // quad-typed. 'skip'/'halt' must resolve it before writing; 'write'
              // validates concurrently, below, without blocking.
              let acceptedQuads = batchQuads;
              if (
                this.validation &&
                batchQuads.length > 0 &&
                onInvalid !== 'write'
              ) {
                acceptedQuads = await this.validateBuffer(batchQuads, dataset);
              }

              // The one type-changing seam: project the root-complete batch into
              // output items, or pass the quads through for a plain stage (`Out`
              // is `Quad` at runtime when there is no projection).
              const items: Iterable<Out> | AsyncIterable<Out> = this.project
                ? this.project(acceptedQuads, {
                    dataset,
                    distribution,
                    stage: this.name,
                    bindings,
                  })
                : (acceptedQuads as unknown as Out[]);
              for await (const item of items) {
                await queue.push(item);
                quadsGenerated++;
              }

              if (
                this.validation &&
                batchQuads.length > 0 &&
                onInvalid === 'write'
              ) {
                pendingValidations.push(
                  this.validation.validator.validate(batchQuads, dataset),
                );
              }

              itemsProcessed += bindings.length;
              options?.onProgress?.(itemsProcessed, quadsGenerated);
            })(),
          );
        }
      } catch (err) {
        firstError ??= err;
      }

      // Wait for all remaining in-flight tasks to settle.
      await Promise.all(inFlight);
      // Ensure all background validations complete before report() is called.
      await Promise.all(pendingValidations);

      if (firstError) {
        queue.abort(firstError);
      } else {
        queue.close();
      }
    };

    const dispatchPromise = dispatch();
    const writePromise = (async () => {
      try {
        await writer.write(dataset, queue);
      } catch (err) {
        queue.abort(err);
        throw err;
      }
    })();

    await Promise.all([dispatchPromise, writePromise]);

    if (!hasResults) {
      return new NotSupported('All readers returned NotSupported');
    }

    this.assertProduced(quadsGenerated);
  }

  /**
   * Validate a buffer of quads. Throws on halt, returns the quads to write
   * (empty array when skipping invalid batches).
   */
  private async validateBuffer(
    buffer: Quad[],
    dataset: Dataset,
  ): Promise<Quad[]> {
    const validationResult = await this.validation!.validator.validate(
      buffer,
      dataset,
    );
    const onInvalid = this.validation!.onInvalid ?? 'write';
    if (!validationResult.conforms && onInvalid === 'halt') {
      throw new Error(
        `Validation failed: ${validationResult.violations} violation(s)${validationResult.message ? `. ${validationResult.message}` : ''}`,
      );
    }
    if (validationResult.conforms || onInvalid === 'write') {
      return buffer;
    }
    // 'skip': discard
    return [];
  }

  private async readAll(
    dataset: Dataset,
    distribution: Distribution,
    timeout: TimeoutPolicy | undefined,
  ): Promise<AsyncIterable<Quad>[] | NotSupported> {
    const results = await Promise.all(
      this.readers.map(async ({ reader, transforms }) => {
        const result = await reader.read(dataset, distribution, {
          timeout,
        });
        if (result instanceof NotSupported) return result;
        return this.applyTransforms(transforms, result, dataset, distribution);
      }),
    );

    const streams: AsyncIterable<Quad>[] = [];
    for (const result of results) {
      if (!(result instanceof NotSupported)) {
        streams.push(result);
      }
    }

    if (streams.length === 0) {
      return new NotSupported('All readers returned NotSupported');
    }

    return streams;
  }

  /**
   * Fold a reader's attached transforms over its output stream, in order,
   * supplying the {@link ReaderContext}. A transform sees one `read()`
   * call's output (see {@link AttachedReader}); `NotSupported` is handled by
   * the caller and never reaches a transform.
   */
  private applyTransforms(
    transforms: QuadTransform<ReaderContext>[],
    stream: AsyncIterable<Quad>,
    dataset: Dataset,
    distribution: Distribution,
  ): AsyncIterable<Quad> {
    if (transforms.length === 0) return stream;
    const context: ReaderContext = {
      dataset,
      distribution,
      stage: this.name,
    };
    return transforms.reduce(
      (quads, transform) => transform(quads, context),
      stream,
    );
  }
}

/** Normalise the {@link StageReaders} union to reader + transforms pairs. */
function normalizeReaders(readers: StageReaders): NormalizedReader[] {
  const list = Array.isArray(readers) ? readers : [readers];
  return list.map((entry) => {
    if ('read' in entry) {
      return { reader: entry, transforms: [] };
    }
    const { reader, transform } = entry;
    const transforms =
      transform === undefined
        ? []
        : Array.isArray(transform)
          ? [...transform]
          : [transform];
    return { reader, transforms };
  });
}

async function* mergeStreams(
  streams: AsyncIterable<Quad>[],
): AsyncIterable<Quad> {
  for (const stream of streams) {
    yield* stream;
  }
}

/**
 * Pass a quad stream through unchanged while counting it, reporting the total
 * via `onCount` once the stream is exhausted. Lets a streaming write enforce
 * {@link StageOptions.expectsOutput} without buffering.
 *
 * `onCount` fires only when the consumer drains the stream – which the pipeline
 * writers do. A writer that stops early would leave the count short; callers
 * relying on it for `expectsOutput` must consume the stream fully.
 */
async function* countQuads(
  stream: AsyncIterable<Quad>,
  onCount: (count: number) => void,
): AsyncIterable<Quad> {
  let count = 0;
  for await (const quad of stream) {
    count++;
    yield quad;
  }
  onCount(count);
}

/** Selects items (as variable bindings) for readers to process. Pagination is an implementation detail. */
export interface ItemSelector {
  select(
    distribution: Distribution,
    batchSize?: number,
    options?: SelectOptions,
  ): AsyncIterable<VariableBindings>;
}
