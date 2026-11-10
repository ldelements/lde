import type {
  StagePhases,
  StageSummary,
  TransformDuration,
} from './pipelineEvent.js';

/**
 * Adds up, over every batch one {@link Stage.run} runs, where it spends its
 * time, phase by phase, and what its transforms and projection count.
 *
 * A stage streams: a reader’s quads flow through its transforms into the
 * writer, and every layer pulls from the one before it. Timing a layer from its
 * first quad to its last would count the layers upstream of it too. So the tally
 * times only the wait on each layer’s `next()`, and takes a layer’s own time as
 * its wait minus the wait of the layer it pulls from. That holds as long as a
 * layer pulls from upstream only while its own `next()` is pending, which an
 * async generator does; a transform that prefetches in the background has its
 * time undercounted, never below zero.
 */
export class StageTally {
  private selectMs = 0;
  private readMs = 0;
  private validateMs = 0;
  private projectMs = 0;
  private writeMs = 0;
  private readonly transforms: TransformDuration[];
  private readonly counts: Record<string, number> = {};

  /** `transformNames` lists every attached transform, readers in order. */
  constructor(transformNames: readonly string[]) {
    this.transforms = transformNames.map((name) => ({ name, durationMs: 0 }));
  }

  /** The item selector, timed while it is iterated. */
  selected<T>(selector: AsyncIterable<T>): AsyncIterable<T> {
    return timed(selector, (milliseconds) => {
      this.selectMs += milliseconds;
    });
  }

  /** How long a reader took to answer, before its quads stream. */
  addRead(milliseconds: number): void {
    this.readMs += milliseconds;
  }

  /**
   * Time one reader’s output and the transforms folded over it. `apply` builds
   * the next layer from the one before; `firstTransform` is the position of the
   * reader’s first transform among all of the stage’s.
   *
   * Returns the timed stream and a `settle` to call once that stream is drained,
   * which adds this chain’s times to the tally.
   */
  chain<T>(
    source: AsyncIterable<T>,
    layers: readonly ((upstream: AsyncIterable<T>) => AsyncIterable<T>)[],
    firstTransform: number,
  ): { stream: AsyncIterable<T>; settle: () => void } {
    // waits[0] is the reader’s, waits[k] the k-th transform’s, each including
    // the waits before it.
    const waits = layers.map(() => 0).concat(0);
    let stream = timed(source, (milliseconds) => {
      waits[0] += milliseconds;
    });
    // A transform’s own work before it returns its stream is its time alone.
    const built = layers.map(() => 0);
    layers.forEach((layer, index) => {
      const started = performance.now();
      const upstream = layer(stream);
      built[index] = performance.now() - started;
      stream = timed(upstream, (milliseconds) => {
        waits[index + 1] += milliseconds;
      });
    });
    return {
      stream,
      settle: () => {
        this.readMs += waits[0];
        for (let index = 0; index < layers.length; index++) {
          this.transforms[firstTransform + index].durationMs +=
            built[index] + Math.max(0, waits[index + 1] - waits[index]);
        }
      },
    };
  }

  /** Time validating one buffer of quads. */
  async validated<T>(validation: Promise<T>): Promise<T> {
    const started = performance.now();
    try {
      return await validation;
    } finally {
      this.validateMs += performance.now() - started;
    }
  }

  /** Time projecting one batch: building the items, then iterating them. */
  projected<T>(
    project: () => Iterable<T> | AsyncIterable<T>,
  ): AsyncIterable<T> {
    const started = performance.now();
    const items = project();
    this.projectMs += performance.now() - started;
    return timed(items, (milliseconds) => {
      this.projectMs += milliseconds;
    });
  }

  /**
   * Time the writer: `write` is handed the items to write and runs to
   * completion. The time it spent waiting on those items is not its own.
   */
  async written<T>(
    items: AsyncIterable<T>,
    write: (items: AsyncIterable<T>) => Promise<void>,
  ): Promise<void> {
    let waitedMs = 0;
    const started = performance.now();
    try {
      await write(
        timed(items, (milliseconds) => {
          waitedMs += milliseconds;
        }),
      );
    } finally {
      this.writeMs += Math.max(0, performance.now() - started - waitedMs);
    }
  }

  /** Add `amount` to the count called `name`. */
  count(name: string, amount: number): void {
    this.counts[name] = (this.counts[name] ?? 0) + amount;
  }

  /** What the stage counted, and its phases rounded to whole milliseconds. */
  summary(): StageSummary {
    return { phases: this.phases(), counts: { ...this.counts } };
  }

  private phases(): StagePhases {
    return {
      selectMs: Math.round(this.selectMs),
      readMs: Math.round(this.readMs),
      transforms: [...sumByName(this.transforms)].map(([name, durationMs]) => ({
        name,
        durationMs: Math.round(durationMs),
      })),
      validateMs: Math.round(this.validateMs),
      projectMs: Math.round(this.projectMs),
      writeMs: Math.round(this.writeMs),
    };
  }
}

/** Add up the durations of transforms sharing a name, in order first seen. */
function sumByName(
  transforms: readonly TransformDuration[],
): Map<string, number> {
  const sums = new Map<string, number>();
  for (const { name, durationMs } of transforms) {
    sums.set(name, (sums.get(name) ?? 0) + durationMs);
  }
  return sums;
}

/**
 * Pass `source` through unchanged, reporting each wait on its `next()` to
 * `onWait`. Accepts a plain iterable too, for a projection that returns an
 * array.
 */
function timed<T>(
  source: Iterable<T> | AsyncIterable<T>,
  onWait: (milliseconds: number) => void,
): AsyncIterable<T> {
  return {
    [Symbol.asyncIterator](): AsyncIterator<T> {
      const iterator =
        Symbol.asyncIterator in source
          ? source[Symbol.asyncIterator]()
          : source[Symbol.iterator]();
      return {
        async next() {
          const started = performance.now();
          try {
            return await iterator.next();
          } finally {
            onWait(performance.now() - started);
          }
        },
        async return(value?: unknown) {
          return (await iterator.return?.(value)) ?? { done: true, value };
        },
      };
    },
  };
}
