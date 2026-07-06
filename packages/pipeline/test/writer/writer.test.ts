import { describe, it, expect, vi } from 'vitest';
import { DataFactory } from 'n3';
import type { Quad } from '@rdfjs/types';
import { Dataset, Distribution } from '@lde/dataset';
import { perDatasetWriter, type RunContext } from '../../src/writer/writer.js';

const { namedNode, literal, quad } = DataFactory;

const dataset = new Dataset({
  iri: new URL('http://example.com/dataset/1'),
  distributions: [Distribution.sparql(new URL('http://example.com/sparql'))],
});

const aQuad = quad(
  namedNode('http://example.com/s'),
  namedNode('http://example.com/p'),
  literal('o'),
);

async function* quadsOf(...quads: Quad[]): AsyncIterable<Quad> {
  yield* quads;
}

function makeRunContext(): RunContext {
  return {
    runId: 'run-1',
    startedAt: '2026-07-06T00:00:00.000Z',
    selectedSources: () => [dataset.iri.toString()],
  };
}

describe('perDatasetWriter', () => {
  it('writes through the underlying writer with a no-op run lifecycle', async () => {
    const written: Quad[] = [];
    const writer = perDatasetWriter({
      write: async (_dataset, items) => {
        for await (const item of items) written.push(item);
      },
    });

    const run = await writer.openRun(makeRunContext());
    await run.write(dataset, quadsOf(aQuad));
    await run.commit();

    expect(written).toEqual([aQuad]);
    // No run lifecycle: a second run writes through the same underlying writer.
    const secondRun = await writer.openRun(makeRunContext());
    await secondRun.write(dataset, quadsOf(aQuad));
    await secondRun.abort(new Error('failure elsewhere'));
    expect(written).toEqual([aQuad, aQuad]);
  });

  it('forwards flush and reset when the underlying writer has them', async () => {
    const flush = vi.fn().mockResolvedValue(undefined);
    const reset = vi.fn().mockResolvedValue(undefined);
    const writer = perDatasetWriter({
      write: () => Promise.resolve(),
      flush,
      reset,
    });

    const run = await writer.openRun(makeRunContext());
    await run.flush?.(dataset);
    await run.reset?.(dataset);

    expect(flush).toHaveBeenCalledExactlyOnceWith(dataset);
    expect(reset).toHaveBeenCalledExactlyOnceWith(dataset);
  });

  it('omits flush and reset when the underlying writer lacks them', async () => {
    const writer = perDatasetWriter({ write: () => Promise.resolve() });

    const run = await writer.openRun(makeRunContext());

    // The pipeline probes these with optional calls; they must be absent
    // rather than throwing stubs.
    expect(run.flush).toBeUndefined();
    expect(run.reset).toBeUndefined();
  });
});
