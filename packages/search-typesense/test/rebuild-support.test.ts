import { describe, expect, it, vi } from 'vitest';
import { Dataset } from '@lde/dataset';
import { type SearchType } from '@lde/search';
import type { DatasetWrites, RunDocuments } from '../src/documents.js';
import {
  resolveRebuildOptions,
  settleDataset,
} from '../src/rebuild-support.js';
import { makeRunContext } from './helpers.js';

describe('resolveRebuildOptions', () => {
  const OBJECT: SearchType = {
    name: 'MuseumObject',
    class: 'https://example.org/Object',
    fields: [],
  };

  it('applies the shared defaults and keeps the residual schema options', () => {
    const resolved = resolveRebuildOptions(OBJECT, {
      collectionNameFor: () => 'objects',
      defaultSortingField: 'rank',
    });

    expect(resolved.batchSize).toBe(1000);
    expect(resolved.lockTtlMs).toBe(600_000);
    expect(resolved.maxRejectedShare).toBe(0.5);
    expect(resolved.definitionOptions.defaultSortingField).toBe('rank');
    expect(resolved.definitionOptions.collectionNameFor(OBJECT)).toBe(
      'objects',
    );
  });

  it('honours explicit overrides', () => {
    const resolved = resolveRebuildOptions(OBJECT, {
      collectionNameFor: () => 'objects',
      batchSize: 50,
      lockTtlMs: 1_000,
    });
    expect(resolved.batchSize).toBe(50);
    expect(resolved.lockTtlMs).toBe(1_000);
  });

  it('derives the name from the type when none is given', () => {
    const resolved = resolveRebuildOptions(OBJECT, {
      defaultSortingField: 'rank',
    });

    // The definition must be built for the very collection the writer talks
    // to, so the naming is resolved to a total function here rather than left
    // undefined – and it names a PEER as readily as this type, which is what a
    // join’s reference field needs.
    expect(resolved.definitionOptions.defaultSortingField).toBe('rank');
    expect(resolved.definitionOptions.collectionNameFor(OBJECT)).toBe(
      'museum_objects',
    );
    expect(
      resolved.definitionOptions.collectionNameFor({
        name: 'Publisher',
        class: 'https://example.org/Publisher',
        fields: [],
      }),
    ).toBe('publishers');
  });
});

describe('settleDataset', () => {
  const WORK: SearchType = {
    name: 'Work',
    class: 'https://example.org/Work',
    fields: [],
  };
  const dataset = new Dataset({
    iri: new URL('http://example.org/dataset/a'),
    distributions: [],
  });

  /** Documents whose settle answers `rejected` of `written`. */
  const settling = (written: number, rejected: number) =>
    ({
      settle: async (): Promise<DatasetWrites> => ({
        written,
        rejected,
        reasons:
          rejected === 0
            ? []
            : [{ reason: 'missing name', count: rejected, examples: ['x'] }],
      }),
    }) as unknown as RunDocuments<{ id: string }>;

  const contextReporting = () => {
    const context = makeRunContext();
    const itemsRejected = vi.fn();
    return { context: { ...context, itemsRejected }, itemsRejected };
  };

  it('reports nothing for a dataset with nothing left out', async () => {
    const { context, itemsRejected } = contextReporting();

    await settleDataset(settling(753, 0), dataset, 'success', context, WORK, 0);

    expect(itemsRejected).not.toHaveBeenCalled();
  });

  it('reports what was left out and keeps a dataset within the share', async () => {
    const { context, itemsRejected } = contextReporting();

    await settleDataset(
      settling(753, 107),
      dataset,
      'success',
      context,
      WORK,
      0.5,
    );

    expect(itemsRejected).toHaveBeenCalledWith(dataset, {
      target: 'Work',
      written: 753,
      rejected: 107,
      reasons: [{ reason: 'missing name', count: 107, examples: ['x'] }],
    });
  });

  it('fails a dataset that left out more than the share, after reporting it', async () => {
    const { context, itemsRejected } = contextReporting();

    await expect(
      settleDataset(settling(10, 6), dataset, 'success', context, WORK, 0.5),
    ).rejects.toThrow(
      '“Work” left out 6 of 10 documents of http://example.org/dataset/a, more than the 50% maxRejectedShare allows: 6 × missing name',
    );
    expect(itemsRejected).toHaveBeenCalledOnce();
  });

  it('fails a dataset whose every document was left out, whatever the share', async () => {
    const { context } = contextReporting();

    await expect(
      settleDataset(settling(3, 3), dataset, 'success', context, WORK, 1),
    ).rejects.toThrow(/left out 3 of 3 documents .*, every one of them: /);
  });

  it('only reports a dataset that already failed, whatever it left out', async () => {
    const { context, itemsRejected } = contextReporting();

    await settleDataset(settling(4, 3), dataset, 'failed', context, WORK, 0);

    expect(itemsRejected).toHaveBeenCalledOnce();
  });

  it('prints the share as a percentage a person would write', async () => {
    const { context } = contextReporting();

    await expect(
      settleDataset(settling(100, 8), dataset, 'success', context, WORK, 0.07),
    ).rejects.toThrow('more than the 7% maxRejectedShare allows');
  });

  it('fails on the first rejection with a share of 0', async () => {
    const { context } = contextReporting();

    await expect(
      settleDataset(settling(1000, 1), dataset, 'success', context, WORK, 0),
    ).rejects.toThrow(/left out 1 of 1000/);
  });

  it('refuses a share outside 0 to 1 when the writer is built', () => {
    expect(() =>
      resolveRebuildOptions(WORK, { maxRejectedShare: 1.5 }),
    ).toThrow('maxRejectedShare must be a share from 0 to 1, got 1.5.');
  });
});
