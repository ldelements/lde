import { describe, it, expect, vi } from 'vitest';
import { DataFactory } from 'n3';
import type { Quad } from '@rdfjs/types';
import { Stage } from '../src/stage.js';
import type {
  ReaderContext,
  ItemSelector,
  QuadTransform,
  RunOptions,
} from '../src/stage.js';
import type { Reader, ReadOptions } from '../src/sparql/reader.js';
import { NotSupported } from '../src/sparql/reader.js';
import { Dataset, Distribution } from '@lde/dataset';
import type { Writer } from '../src/writer/writer.js';
import type {
  Validator,
  ValidationResult,
  ValidationReport,
} from '../src/validator.js';

const { namedNode, quad } = DataFactory;

const q1 = quad(
  namedNode('http://example.org/s1'),
  namedNode('http://example.org/p'),
  namedNode('http://example.org/o1'),
);
const q2 = quad(
  namedNode('http://example.org/s2'),
  namedNode('http://example.org/p'),
  namedNode('http://example.org/o2'),
);
const q3 = quad(
  namedNode('http://example.org/s3'),
  namedNode('http://example.org/p'),
  namedNode('http://example.org/o3'),
);

function mockExecutor(quads: Quad[]): Reader {
  return {
    async read(
      _dataset: Dataset,
      _distribution: Distribution,
      _options?: ReadOptions,
    ): Promise<AsyncIterable<Quad> | NotSupported> {
      return (async function* () {
        yield* quads;
      })();
    },
  };
}

function capturingExecutor(quads: Quad[]): Reader & {
  read: ReturnType<typeof vi.fn>;
} {
  const reader = {
    read: vi.fn(
      async (
        _dataset: Dataset,
        _distribution: Distribution,
        _options?: ReadOptions,
      ): Promise<AsyncIterable<Quad> | NotSupported> => {
        return (async function* () {
          yield* quads;
        })();
      },
    ),
  };
  return reader;
}

function notSupportedExecutor(message = 'not supported'): Reader {
  return {
    async read(): Promise<AsyncIterable<Quad> | NotSupported> {
      return new NotSupported(message);
    },
  };
}

function mockItemSelector(
  rows: Record<string, ReturnType<typeof namedNode>>[],
): ItemSelector {
  return {
    async *select() {
      yield* rows;
    },
  };
}

function collectingWriter(): Writer & { quads: Quad[] } {
  const quads: Quad[] = [];
  return {
    quads,
    async write(_dataset, data) {
      for await (const quad of data) {
        quads.push(quad);
      }
    },
  };
}

const dataset = new Dataset({
  iri: new URL('http://example.org/dataset'),
  distributions: [],
});

const distribution = Distribution.sparql(new URL('http://example.org/sparql'));

describe('Stage', () => {
  it('writes quads from a single reader', async () => {
    const stage = new Stage({
      name: 'test',
      readers: mockExecutor([q1, q2]),
    });

    const writer = collectingWriter();
    const result = await stage.run(dataset, distribution, writer);
    expect(result).not.toBeInstanceOf(NotSupported);
    expect(writer.quads).toEqual([q1, q2]);
  });

  it('returns NotSupported when single reader returns NotSupported', async () => {
    const stage = new Stage({
      name: 'test',
      readers: notSupportedExecutor(),
    });

    const writer = collectingWriter();
    const result = await stage.run(dataset, distribution, writer);
    expect(result).toBeInstanceOf(NotSupported);
    expect((result as NotSupported).message).toBe(
      'All readers returned NotSupported',
    );
    expect(writer.quads).toEqual([]);
  });

  it('writes all quads merged from multiple readers', async () => {
    const stage = new Stage({
      name: 'test',
      readers: [mockExecutor([q1]), mockExecutor([q2, q3])],
    });

    const writer = collectingWriter();
    const result = await stage.run(dataset, distribution, writer);
    expect(result).not.toBeInstanceOf(NotSupported);
    expect(writer.quads).toEqual([q1, q2, q3]);
  });

  it('writes quads only from successful readers when some return NotSupported', async () => {
    const stage = new Stage({
      name: 'test',
      readers: [
        notSupportedExecutor(),
        mockExecutor([q1, q2]),
        notSupportedExecutor(),
      ],
    });

    const writer = collectingWriter();
    const result = await stage.run(dataset, distribution, writer);
    expect(result).not.toBeInstanceOf(NotSupported);
    expect(writer.quads).toEqual([q1, q2]);
  });

  it('returns NotSupported when all readers return NotSupported', async () => {
    const stage = new Stage({
      name: 'test',
      readers: [notSupportedExecutor('a'), notSupportedExecutor('b')],
    });

    const writer = collectingWriter();
    const result = await stage.run(dataset, distribution, writer);
    expect(result).toBeInstanceOf(NotSupported);
    expect((result as NotSupported).message).toBe(
      'All readers returned NotSupported',
    );
    expect(writer.quads).toEqual([]);
  });

  it('passes item selector bindings to readers in a single batch', async () => {
    const reader = capturingExecutor([q1]);
    const bindings = [
      { class: namedNode('http://example.org/Person') },
      { class: namedNode('http://example.org/Book') },
    ];

    const stage = new Stage({
      name: 'test',
      readers: reader,
      itemSelector: mockItemSelector(bindings),
    });

    const writer = collectingWriter();
    const result = await stage.run(dataset, distribution, writer);
    expect(result).not.toBeInstanceOf(NotSupported);

    expect(reader.read).toHaveBeenCalledOnce();
    expect(reader.read).toHaveBeenCalledWith(
      dataset,
      distribution,
      expect.objectContaining({ bindings }),
    );
  });

  it('batches bindings across multiple reader calls', async () => {
    const reader = capturingExecutor([q1]);
    const bindings = [
      { class: namedNode('http://example.org/A') },
      { class: namedNode('http://example.org/B') },
      { class: namedNode('http://example.org/C') },
    ];

    const stage = new Stage({
      name: 'test',
      readers: reader,
      itemSelector: mockItemSelector(bindings),
      batchSize: 2,
    });

    const writer = collectingWriter();
    const result = await stage.run(dataset, distribution, writer);
    expect(result).not.toBeInstanceOf(NotSupported);

    expect(reader.read).toHaveBeenCalledTimes(2);
    expect(reader.read).toHaveBeenNthCalledWith(
      1,
      dataset,
      distribution,
      expect.objectContaining({ bindings: [bindings[0], bindings[1]] }),
    );
    expect(reader.read).toHaveBeenNthCalledWith(
      2,
      dataset,
      distribution,
      expect.objectContaining({ bindings: [bindings[2]] }),
    );
  });

  it('uses custom batchSize', async () => {
    const reader = capturingExecutor([q1]);
    const bindings = [
      { class: namedNode('http://example.org/A') },
      { class: namedNode('http://example.org/B') },
      { class: namedNode('http://example.org/C') },
    ];

    const stage = new Stage({
      name: 'test',
      readers: reader,
      itemSelector: mockItemSelector(bindings),
      batchSize: 1,
    });

    const writer = collectingWriter();
    await stage.run(dataset, distribution, writer);

    expect(reader.read).toHaveBeenCalledTimes(3);
  });

  it('returns NotSupported when item selector yields nothing', async () => {
    const reader = capturingExecutor([q1]);

    const stage = new Stage({
      name: 'test',
      readers: reader,
      itemSelector: mockItemSelector([]),
    });

    const writer = collectingWriter();
    const result = await stage.run(dataset, distribution, writer);
    expect(result).toBeInstanceOf(NotSupported);
    expect(reader.read).not.toHaveBeenCalled();
  });

  it('works without an item selector', async () => {
    const reader = capturingExecutor([q1, q2]);

    const stage = new Stage({
      name: 'test',
      readers: reader,
    });

    const writer = collectingWriter();
    const result = await stage.run(dataset, distribution, writer);
    expect(result).not.toBeInstanceOf(NotSupported);
    expect(writer.quads).toEqual([q1, q2]);
    expect(reader.read).toHaveBeenCalledWith(
      dataset,
      distribution,
      expect.objectContaining({}),
    );
  });

  it('forwards distribution to readers', async () => {
    const reader = capturingExecutor([q1]);
    const namedGraphDistribution = Distribution.sparql(
      new URL('http://example.org/sparql'),
      'http://example.org/graph',
    );

    const stage = new Stage({
      name: 'test',
      readers: reader,
    });

    const writer = collectingWriter();
    await stage.run(dataset, namedGraphDistribution, writer);

    expect(reader.read).toHaveBeenCalledWith(
      dataset,
      namedGraphDistribution,
      expect.objectContaining({}),
    );
  });

  it('passes the distribution to the item selector', async () => {
    const reader = capturingExecutor([q1]);
    const bindings = [{ class: namedNode('http://example.org/Person') }];
    const selectFn = vi.fn(async function* () {
      yield* bindings;
    });

    const stage = new Stage({
      name: 'test',
      readers: reader,
      itemSelector: { select: selectFn },
    });

    const writer = collectingWriter();
    const result = await stage.run(dataset, distribution, writer);
    expect(result).not.toBeInstanceOf(NotSupported);

    expect(selectFn).toHaveBeenCalledWith(
      distribution,
      10,
      expect.objectContaining({}),
    );
    expect(reader.read).toHaveBeenCalledWith(
      dataset,
      distribution,
      expect.objectContaining({ bindings }),
    );
  });

  it('passes batchSize to item selector', async () => {
    const reader = capturingExecutor([q1]);
    const selectFn = vi.fn(async function* () {
      yield { class: namedNode('http://example.org/Person') };
    });

    const stage = new Stage({
      name: 'test',
      readers: reader,
      itemSelector: { select: selectFn },
      batchSize: 500,
    });

    const writer = collectingWriter();
    await stage.run(dataset, distribution, writer);

    expect(selectFn).toHaveBeenCalledWith(
      distribution,
      500,
      expect.objectContaining({}),
    );
  });

  describe('sub-stages', () => {
    it('stores sub-stages', () => {
      const child1 = new Stage({ name: 'child1', readers: mockExecutor([]) });
      const child2 = new Stage({ name: 'child2', readers: mockExecutor([]) });
      const parent = new Stage({
        name: 'parent',
        readers: mockExecutor([]),
        stages: [child1, child2],
      });

      expect(parent.stages).toEqual([child1, child2]);
    });

    it('defaults to empty stages', () => {
      const stage = new Stage({ name: 'test', readers: mockExecutor([]) });
      expect(stage.stages).toEqual([]);
    });
  });

  describe('concurrent execution', () => {
    function delayExecutor(
      quads: Quad[],
      delayMs: number,
      tracker: { current: number; max: number },
    ): Reader {
      return {
        async read(
          _dataset: Dataset,
          _distribution: Distribution,
          _options?: ReadOptions,
        ): Promise<AsyncIterable<Quad> | NotSupported> {
          tracker.current++;
          tracker.max = Math.max(tracker.max, tracker.current);
          await new Promise((resolve) => setTimeout(resolve, delayMs));
          tracker.current--;
          return (async function* () {
            yield* quads;
          })();
        },
      };
    }

    function failingExecutor(failOnCall: number): Reader {
      let callCount = 0;
      return {
        async read(): Promise<AsyncIterable<Quad> | NotSupported> {
          callCount++;
          if (callCount === failOnCall) {
            throw new Error('reader failure');
          }
          return (async function* () {
            yield q1;
          })();
        },
      };
    }

    it('runs multiple readers in parallel within a batch', async () => {
      const tracker = { current: 0, max: 0 };
      const stage = new Stage({
        name: 'test',
        readers: [
          delayExecutor([q1], 30, tracker),
          delayExecutor([q2], 30, tracker),
        ],
        itemSelector: mockItemSelector([
          { class: namedNode('http://example.org/A') },
        ]),
        batchSize: 1,
        maxConcurrency: 1,
      });

      const writer = collectingWriter();
      await stage.run(dataset, distribution, writer);

      // Both readers should have run concurrently within the single batch.
      expect(tracker.max).toBe(2);
      expect(writer.quads).toEqual([q1, q2]);
    });

    it('runs reader batches concurrently', async () => {
      const tracker = { current: 0, max: 0 };
      const stage = new Stage({
        name: 'test',
        readers: delayExecutor([q1], 20, tracker),
        itemSelector: mockItemSelector([
          { class: namedNode('http://example.org/A') },
          { class: namedNode('http://example.org/B') },
          { class: namedNode('http://example.org/C') },
          { class: namedNode('http://example.org/D') },
        ]),
        batchSize: 1,
        maxConcurrency: 2,
      });

      const writer = collectingWriter();
      await stage.run(dataset, distribution, writer);

      expect(tracker.max).toBe(2);
      expect(writer.quads).toHaveLength(4);
    });

    it('shares maxConcurrency across parallel readers', async () => {
      const tracker = { current: 0, max: 0 };
      // 2 readers with maxConcurrency=4 → 2 concurrent batches × 2 readers = 4 queries.
      const stage = new Stage({
        name: 'test',
        readers: [
          delayExecutor([q1], 30, tracker),
          delayExecutor([q2], 30, tracker),
        ],
        itemSelector: mockItemSelector([
          { class: namedNode('http://example.org/A') },
          { class: namedNode('http://example.org/B') },
          { class: namedNode('http://example.org/C') },
          { class: namedNode('http://example.org/D') },
        ]),
        batchSize: 1,
        maxConcurrency: 4,
      });

      const writer = collectingWriter();
      await stage.run(dataset, distribution, writer);

      // 2 batches × 2 readers = 4 concurrent queries, within maxConcurrency.
      expect(tracker.max).toBeLessThanOrEqual(4);
      expect(writer.quads).toHaveLength(8);
    });

    it('bounds parallelism to maxConcurrency', async () => {
      const tracker = { current: 0, max: 0 };
      const stage = new Stage({
        name: 'test',
        readers: delayExecutor([q1], 10, tracker),
        itemSelector: mockItemSelector([
          { class: namedNode('http://example.org/A') },
          { class: namedNode('http://example.org/B') },
          { class: namedNode('http://example.org/C') },
          { class: namedNode('http://example.org/D') },
          { class: namedNode('http://example.org/E') },
          { class: namedNode('http://example.org/F') },
        ]),
        batchSize: 1,
        maxConcurrency: 3,
      });

      const writer = collectingWriter();
      await stage.run(dataset, distribution, writer);

      expect(tracker.max).toBeLessThanOrEqual(3);
      expect(writer.quads).toHaveLength(6);
    });

    it('propagates reader errors', async () => {
      const stage = new Stage({
        name: 'test',
        readers: failingExecutor(2),
        itemSelector: mockItemSelector([
          { class: namedNode('http://example.org/A') },
          { class: namedNode('http://example.org/B') },
          { class: namedNode('http://example.org/C') },
        ]),
        batchSize: 1,
        maxConcurrency: 1,
      });

      const writer = collectingWriter();
      await expect(stage.run(dataset, distribution, writer)).rejects.toThrow(
        'reader failure',
      );
    });

    it('propagates error when one of multiple parallel readers fails', async () => {
      const stage = new Stage({
        name: 'test',
        readers: [
          mockExecutor([q1]),
          {
            async read(): Promise<AsyncIterable<Quad> | NotSupported> {
              throw new Error('second reader failed');
            },
          },
        ],
        itemSelector: mockItemSelector([
          { class: namedNode('http://example.org/A') },
        ]),
        batchSize: 1,
      });

      const writer = collectingWriter();
      await expect(stage.run(dataset, distribution, writer)).rejects.toThrow(
        'second reader failed',
      );
    });

    it('stops execution when writer throws', async () => {
      const tracker = { current: 0, max: 0 };
      const stage = new Stage({
        name: 'test',
        readers: delayExecutor([q1, q2], 10, tracker),
        itemSelector: mockItemSelector([
          { class: namedNode('http://example.org/A') },
          { class: namedNode('http://example.org/B') },
          { class: namedNode('http://example.org/C') },
        ]),
        batchSize: 1,
        maxConcurrency: 1,
      });

      let quadsSeen = 0;
      const failingWriter: Writer = {
        async write(_dataset, quads) {
          for await (const _quad of quads) {
            quadsSeen++;
            if (quadsSeen >= 1) {
              throw new Error('writer failure');
            }
          }
        },
      };

      await expect(
        stage.run(dataset, distribution, failingWriter),
      ).rejects.toThrow('writer failure');
    });

    it('calls onProgress callback', async () => {
      const progressCalls: Array<{
        items: number;
        quads: number;
      }> = [];

      const stage = new Stage({
        name: 'test',
        readers: mockExecutor([q1]),
        itemSelector: mockItemSelector([
          { class: namedNode('http://example.org/A') },
          { class: namedNode('http://example.org/B') },
          { class: namedNode('http://example.org/C') },
        ]),
        batchSize: 1,
        maxConcurrency: 1,
      });

      const writer = collectingWriter();
      const options: RunOptions = {
        onProgress: (items, quads) => {
          progressCalls.push({ items, quads });
        },
      };

      await stage.run(dataset, distribution, writer, options);

      expect(progressCalls).toHaveLength(3);
      // With maxConcurrency=1, execution is sequential so progress is monotonic.
      expect(progressCalls[0].items).toBe(1);
      expect(progressCalls[1].items).toBe(2);
      expect(progressCalls[2].items).toBe(3);
    });

    it('returns NotSupported when all readers return NotSupported with item selector', async () => {
      const stage = new Stage({
        name: 'test',
        readers: notSupportedExecutor(),
        itemSelector: mockItemSelector([
          { class: namedNode('http://example.org/A') },
          { class: namedNode('http://example.org/B') },
        ]),
        batchSize: 1,
        maxConcurrency: 2,
      });

      const writer = collectingWriter();
      const result = await stage.run(dataset, distribution, writer);
      expect(result).toBeInstanceOf(NotSupported);
      expect(writer.quads).toEqual([]);
    });
  });

  describe('validation', () => {
    function mockValidator(
      options: { conforms: boolean; violations?: number } = { conforms: true },
    ): Validator {
      const violations = options.violations ?? (options.conforms ? 0 : 1);
      return {
        validate: vi.fn(
          async (): Promise<ValidationResult> => ({
            conforms: options.conforms,
            violations,
          }),
        ),
        report: vi.fn(
          async (): Promise<ValidationReport> => ({
            conforms: options.conforms,
            violations,
            quadsValidated: 0,
          }),
        ),
      };
    }

    it('writes quads when validation conforms (no selector)', async () => {
      const validator = mockValidator({ conforms: true });
      const stage = new Stage({
        name: 'test',
        readers: mockExecutor([q1, q2]),
        validation: { validator },
      });

      const writer = collectingWriter();
      await stage.run(dataset, distribution, writer);
      expect(writer.quads).toEqual([q1, q2]);
      expect(validator.validate).toHaveBeenCalledOnce();
    });

    it('writes quads when validation conforms (with selector)', async () => {
      const validator = mockValidator({ conforms: true });
      const stage = new Stage({
        name: 'test',
        readers: mockExecutor([q1]),
        itemSelector: mockItemSelector([
          { class: namedNode('http://example.org/A') },
        ]),
        validation: { validator },
      });

      const writer = collectingWriter();
      await stage.run(dataset, distribution, writer);
      expect(writer.quads).toEqual([q1]);
      expect(validator.validate).toHaveBeenCalledOnce();
    });

    it('writes quads when validation fails with onInvalid "write" (default)', async () => {
      const validator = mockValidator({ conforms: false });
      const stage = new Stage({
        name: 'test',
        readers: mockExecutor([q1, q2]),
        validation: { validator },
      });

      const writer = collectingWriter();
      await stage.run(dataset, distribution, writer);
      expect(writer.quads).toEqual([q1, q2]);
    });

    it('skips quads when validation fails with onInvalid "skip" (no selector)', async () => {
      const validator = mockValidator({ conforms: false });
      const stage = new Stage({
        name: 'test',
        readers: mockExecutor([q1, q2]),
        validation: { validator, onInvalid: 'skip' },
      });

      const writer = collectingWriter();
      await stage.run(dataset, distribution, writer);
      expect(writer.quads).toEqual([]);
    });

    it('skips quads when validation fails with onInvalid "skip" (with selector)', async () => {
      const validator = mockValidator({ conforms: false });
      const stage = new Stage({
        name: 'test',
        readers: mockExecutor([q1]),
        itemSelector: mockItemSelector([
          { class: namedNode('http://example.org/A') },
        ]),
        validation: { validator, onInvalid: 'skip' },
      });

      const writer = collectingWriter();
      await stage.run(dataset, distribution, writer);
      expect(writer.quads).toEqual([]);
    });

    it('throws when validation fails with onInvalid "halt" (no selector)', async () => {
      const validator = mockValidator({ conforms: false, violations: 3 });
      const stage = new Stage({
        name: 'test',
        readers: mockExecutor([q1]),
        validation: { validator, onInvalid: 'halt' },
      });

      const writer = collectingWriter();
      await expect(stage.run(dataset, distribution, writer)).rejects.toThrow(
        'Validation failed: 3 violation(s)',
      );
    });

    it('throws when validation fails with onInvalid "halt" (with selector)', async () => {
      const validator = mockValidator({ conforms: false, violations: 2 });
      const stage = new Stage({
        name: 'test',
        readers: mockExecutor([q1]),
        itemSelector: mockItemSelector([
          { class: namedNode('http://example.org/A') },
        ]),
        validation: { validator, onInvalid: 'halt' },
      });

      const writer = collectingWriter();
      await expect(stage.run(dataset, distribution, writer)).rejects.toThrow(
        'Validation failed: 2 violation(s)',
      );
    });

    it('validates combined output of multiple readers', async () => {
      const validator = mockValidator({ conforms: true });
      const stage = new Stage({
        name: 'test',
        readers: [mockExecutor([q1]), mockExecutor([q2])],
        validation: { validator },
      });

      const writer = collectingWriter();
      await stage.run(dataset, distribution, writer);

      expect(validator.validate).toHaveBeenCalledOnce();
      expect(validator.validate).toHaveBeenCalledWith([q1, q2], dataset);
      expect(writer.quads).toEqual([q1, q2]);
    });

    it('writes quads without waiting for validation when onInvalid is "write" (no selector)', async () => {
      const writeOrder: string[] = [];
      const validator: Validator = {
        validate: vi.fn(async (): Promise<ValidationResult> => {
          await new Promise((resolve) => setTimeout(resolve, 50));
          writeOrder.push('validate');
          return { conforms: true, violations: 0 };
        }),
        report: vi.fn(
          async (): Promise<ValidationReport> => ({
            conforms: true,
            violations: 0,
            quadsValidated: 2,
          }),
        ),
      };

      const writer: Writer = {
        async write(_dataset, data) {
          for await (const _quad of data) {
            writeOrder.push('write');
          }
        },
      };

      const stage = new Stage({
        name: 'test',
        readers: mockExecutor([q1, q2]),
        validation: { validator },
      });

      await stage.run(dataset, distribution, writer);

      // Writes happen before validation completes.
      expect(writeOrder.indexOf('write')).toBeLessThan(
        writeOrder.indexOf('validate'),
      );
      expect(validator.validate).toHaveBeenCalledOnce();
    });

    it('writes quads without waiting for validation when onInvalid is "write" (with selector)', async () => {
      const writeOrder: string[] = [];
      const validator: Validator = {
        validate: vi.fn(async (): Promise<ValidationResult> => {
          await new Promise((resolve) => setTimeout(resolve, 50));
          writeOrder.push('validate');
          return { conforms: false, violations: 1 };
        }),
        report: vi.fn(
          async (): Promise<ValidationReport> => ({
            conforms: false,
            violations: 1,
            quadsValidated: 1,
          }),
        ),
      };

      const writer: Writer = {
        async write(_dataset, data) {
          for await (const _quad of data) {
            writeOrder.push('write');
          }
        },
      };

      const stage = new Stage({
        name: 'test',
        readers: mockExecutor([q1]),
        itemSelector: mockItemSelector([
          { class: namedNode('http://example.org/A') },
        ]),
        validation: { validator },
      });

      await stage.run(dataset, distribution, writer);

      // Writes happen before validation completes.
      expect(writeOrder.indexOf('write')).toBeLessThan(
        writeOrder.indexOf('validate'),
      );
      expect(validator.validate).toHaveBeenCalledOnce();
    });

    it('validates combined output of multiple readers (with selector)', async () => {
      const validator = mockValidator({ conforms: true });
      const stage = new Stage({
        name: 'test',
        readers: [mockExecutor([q1]), mockExecutor([q2])],
        itemSelector: mockItemSelector([
          { class: namedNode('http://example.org/A') },
        ]),
        validation: { validator },
      });

      const writer = collectingWriter();
      await stage.run(dataset, distribution, writer);

      expect(validator.validate).toHaveBeenCalledOnce();
      expect(validator.validate).toHaveBeenCalledWith([q1, q2], dataset);
      expect(writer.quads).toEqual([q1, q2]);
    });
  });

  describe('attached transforms', () => {
    const extra = quad(
      namedNode('http://example.org/extra'),
      namedNode('http://example.org/p'),
      namedNode('http://example.org/o'),
    );

    function appendTransform(toAppend: Quad): QuadTransform<ReaderContext> {
      return async function* (quads) {
        yield* quads;
        yield toAppend;
      };
    }

    it('applies an attached transform to the reader output', async () => {
      const stage = new Stage({
        name: 'test',
        readers: {
          reader: mockExecutor([q1]),
          transform: appendTransform(extra),
        },
      });

      const writer = collectingWriter();
      await stage.run(dataset, distribution, writer);
      expect(writer.quads).toEqual([q1, extra]);
    });

    it('supplies the ReaderContext to the transform', async () => {
      let seen: ReaderContext | undefined;
      const transform: QuadTransform<ReaderContext> = async function* (
        quads,
        context,
      ) {
        seen = context;
        yield* quads;
      };

      const stage = new Stage({
        name: 'my-stage',
        readers: { reader: mockExecutor([q1]), transform },
      });

      await stage.run(dataset, distribution, collectingWriter());
      expect(seen).toEqual({ dataset, distribution, stage: 'my-stage' });
    });

    it('applies multiple attached transforms in order', async () => {
      const stage = new Stage({
        name: 'test',
        readers: {
          reader: mockExecutor([q1]),
          transform: [appendTransform(q2), appendTransform(q3)],
        },
      });

      const writer = collectingWriter();
      await stage.run(dataset, distribution, writer);
      expect(writer.quads).toEqual([q1, q2, q3]);
    });

    it('transforms only the attached reader, not its siblings', async () => {
      const stage = new Stage({
        name: 'test',
        readers: [
          { reader: mockExecutor([q1]), transform: appendTransform(extra) },
          mockExecutor([q2]),
        ],
      });

      const writer = collectingWriter();
      await stage.run(dataset, distribution, writer);
      expect(writer.quads).toEqual([q1, extra, q2]);
    });

    it('does not apply the transform when the reader returns NotSupported', async () => {
      let called = false;
      const transform: QuadTransform<ReaderContext> = async function* (quads) {
        called = true;
        yield* quads;
        yield extra;
      };

      const stage = new Stage({
        name: 'test',
        readers: { reader: notSupportedExecutor(), transform },
      });

      const result = await stage.run(dataset, distribution, collectingWriter());
      expect(result).toBeInstanceOf(NotSupported);
      expect(called).toBe(false);
    });

    it('applies the transform per read() call on a per-class stage', async () => {
      // batchSize 1 → one read() per class → the transform runs per class.
      const stage = new Stage({
        name: 'test',
        readers: {
          reader: mockExecutor([q1]),
          transform: appendTransform(extra),
        },
        itemSelector: mockItemSelector([
          { class: namedNode('http://example.org/A') },
          { class: namedNode('http://example.org/B') },
        ]),
        batchSize: 1,
      });

      const writer = collectingWriter();
      await stage.run(dataset, distribution, writer);
      expect(writer.quads.filter((q) => q.equals(extra))).toHaveLength(2);
      expect(writer.quads.filter((q) => q.equals(q1))).toHaveLength(2);
    });
  });

  describe('expectsOutput', () => {
    it('throws when a supported stage produces no quads', async () => {
      // A scalar aggregate (e.g. COUNT) always returns a row; zero output means
      // the endpoint truncated the response — a hard failure, not an empty result.
      const stage = new Stage({
        name: 'triples-count',
        readers: mockExecutor([]),
        expectsOutput: true,
      });

      const writer = collectingWriter();
      await expect(stage.run(dataset, distribution, writer)).rejects.toThrow(
        /triples-count/,
      );
    });

    it('does not throw when the stage produces quads', async () => {
      const stage = new Stage({
        name: 'triples-count',
        readers: mockExecutor([q1]),
        expectsOutput: true,
      });

      const writer = collectingWriter();
      const result = await stage.run(dataset, distribution, writer);
      expect(result).not.toBeInstanceOf(NotSupported);
      expect(writer.quads).toEqual([q1]);
    });

    it('tolerates an empty result by default', async () => {
      const stage = new Stage({
        name: 'class-partition',
        readers: mockExecutor([]),
      });

      const writer = collectingWriter();
      const result = await stage.run(dataset, distribution, writer);
      expect(result).not.toBeInstanceOf(NotSupported);
      expect(writer.quads).toEqual([]);
    });

    it('returns NotSupported (not a failure) when the reader is unsupported', async () => {
      // expectsOutput concerns a supported-but-empty response; an unsupported
      // reader is a skip, never a hard failure.
      const stage = new Stage({
        name: 'triples-count',
        readers: notSupportedExecutor(),
        expectsOutput: true,
      });

      const writer = collectingWriter();
      const result = await stage.run(dataset, distribution, writer);
      expect(result).toBeInstanceOf(NotSupported);
    });

    it('throws for an item-selected stage that produces no quads', async () => {
      const stage = new Stage({
        name: 'per-class-count',
        itemSelector: mockItemSelector([{ class: namedNode('http://x') }]),
        readers: mockExecutor([]),
        expectsOutput: true,
      });

      const writer = collectingWriter();
      await expect(stage.run(dataset, distribution, writer)).rejects.toThrow(
        /per-class-count/,
      );
    });
  });
});
