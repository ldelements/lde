import { Dataset, Distribution } from '@lde/dataset';
import type { Quad } from '@rdfjs/types';
import type { Executor, VariableBindings } from './sparql/executor.js';
import { NotSupported } from './sparql/executor.js';
import type { TimeoutPolicy } from './sparql/timeoutPolicy.js';
import { batch } from './batch.js';
import type { Validator } from './validator.js';
import type { Writer } from './writer/writer.js';
import { AsyncQueue } from './asyncQueue.js';

/** Transforms a quad stream, optionally using dataset metadata. */
export type QuadTransform = (
  quads: AsyncIterable<Quad>,
  dataset: Dataset,
) => AsyncIterable<Quad>;

export interface StageOptions {
  name: string;
  executors: Executor | Executor[];
  itemSelector?: ItemSelector;
  /**
   * Maximum number of bindings per executor call.
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
   * executors run in parallel; the number of concurrent batches is
   * automatically reduced to `⌊maxConcurrency / executorCount⌋` so the
   * total query pressure stays within this limit.
   *
   * @default 10
   */
  maxConcurrency?: number;
  /** Child stages that chain off this stage's output. */
  stages?: Stage[];
  /** Optional validation of the combined quads produced by all executors per batch. */
  validation?: {
    validator: Validator;
    /** What to do when a batch fails validation. @default 'write' */
    onInvalid?: 'write' | 'skip' | 'halt';
  };
}

export interface RunOptions {
  onProgress?: (itemsProcessed: number, quadsGenerated: number) => void;
  /**
   * Per-dataset {@link TimeoutPolicy} threaded through to executors and
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

export class Stage {
  readonly name: string;
  readonly stages: readonly Stage[];
  private readonly executors: Executor[];
  private readonly itemSelector?: ItemSelector;
  private readonly batchSize: number;
  private readonly maxConcurrency: number;
  private readonly validation?: StageOptions['validation'];

  constructor(options: StageOptions) {
    this.name = options.name;
    this.stages = options.stages ?? [];
    this.executors = Array.isArray(options.executors)
      ? options.executors
      : [options.executors];
    this.itemSelector = options.itemSelector;
    this.batchSize = options.batchSize ?? 10;
    this.maxConcurrency = options.maxConcurrency ?? 10;
    this.validation = options.validation;
  }

  /** The validator for this stage, if configured. */
  get validator(): Validator | undefined {
    return this.validation?.validator;
  }

  async run(
    dataset: Dataset,
    distribution: Distribution,
    writer: Writer,
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

    const streams = await this.executeAll(dataset, distribution, timeout);
    if (streams instanceof NotSupported) {
      return streams;
    }

    if (this.validation) {
      const buffer: Quad[] = [];
      for (const stream of streams) {
        for await (const quad of stream) {
          buffer.push(quad);
        }
      }
      const onInvalid = this.validation.onInvalid ?? 'write';
      if (onInvalid === 'write') {
        await Promise.all([
          writer.write(
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
          await writer.write(
            dataset,
            (async function* () {
              yield* accepted;
            })(),
          );
        }
      }
    } else {
      await writer.write(dataset, mergeStreams(streams));
    }
  }

  private async runWithSelector(
    selector: AsyncIterable<VariableBindings>,
    dataset: Dataset,
    distribution: Distribution,
    writer: Writer,
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

    const queue = new AsyncQueue<Quad>();
    let itemsProcessed = 0;
    let quadsGenerated = 0;
    let hasResults = false;

    const onInvalid = this.validation?.onInvalid ?? 'write';
    const pendingValidations: Promise<unknown>[] = [];

    const dispatch = async () => {
      const inFlight = new Set<Promise<void>>();
      let firstError: unknown;

      // Divide maxConcurrency by executor count so the total concurrent
      // SPARQL queries stays at maxConcurrency (each batch runs all
      // executors in parallel).
      const maxConcurrentBatches = Math.max(
        1,
        Math.floor(this.maxConcurrency / this.executors.length),
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
              // Run all executors for this batch in parallel.
              const executorOutputs = await Promise.all(
                this.executors.map(async (executor) => {
                  const result = await executor.execute(dataset, distribution, {
                    bindings,
                    timeout: options?.timeout,
                  });
                  if (result instanceof NotSupported) return [];
                  hasResults = true;
                  const quads: Quad[] = [];
                  for await (const quad of result) {
                    quads.push(quad);
                  }
                  return quads;
                }),
              );
              const batchQuads = executorOutputs.flat();

              if (
                this.validation &&
                batchQuads.length > 0 &&
                onInvalid !== 'write'
              ) {
                // 'skip' or 'halt': must await validation before deciding to write.
                const accepted = await this.validateBuffer(batchQuads, dataset);
                for (const quad of accepted) {
                  await queue.push(quad);
                  quadsGenerated++;
                }
              } else {
                for (const quad of batchQuads) {
                  await queue.push(quad);
                  quadsGenerated++;
                }
                if (this.validation && batchQuads.length > 0) {
                  // 'write' mode: validate concurrently without blocking the write path.
                  pendingValidations.push(
                    this.validation.validator.validate(batchQuads, dataset),
                  );
                }
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
      return new NotSupported('All executors returned NotSupported');
    }
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

  private async executeAll(
    dataset: Dataset,
    distribution: Distribution,
    timeout: TimeoutPolicy | undefined,
  ): Promise<AsyncIterable<Quad>[] | NotSupported> {
    const results = await Promise.all(
      this.executors.map((executor) =>
        executor.execute(dataset, distribution, { timeout }),
      ),
    );

    const streams: AsyncIterable<Quad>[] = [];
    for (const result of results) {
      if (!(result instanceof NotSupported)) {
        streams.push(result);
      }
    }

    if (streams.length === 0) {
      return new NotSupported('All executors returned NotSupported');
    }

    return streams;
  }
}

async function* mergeStreams(
  streams: AsyncIterable<Quad>[],
): AsyncIterable<Quad> {
  for (const stream of streams) {
    yield* stream;
  }
}

/** Selects items (as variable bindings) for executors to process. Pagination is an implementation detail. */
export interface ItemSelector {
  select(
    distribution: Distribution,
    batchSize?: number,
    options?: SelectOptions,
  ): AsyncIterable<VariableBindings>;
}
