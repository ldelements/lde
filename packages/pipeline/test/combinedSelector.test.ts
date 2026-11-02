import { Dataset } from '@lde/dataset';
import { Paginator } from '@lde/dataset-registry-client';
import { describe, expect, it, vi } from 'vitest';
import {
  CombinedSelector,
  ManualDatasetSelection,
  type DatasetSelector,
} from '../src/selector.js';

function datasets(...names: string[]): Dataset[] {
  return names.map(
    (name) =>
      new Dataset({
        iri: new URL(`https://example.org/${name}`),
        distributions: [],
      }),
  );
}

async function selectedIris(selector: DatasetSelector): Promise<string[]> {
  const iris = [];
  for await (const dataset of await selector.select()) {
    iris.push(dataset.iri.toString());
  }
  return iris;
}

describe('CombinedSelector', () => {
  it('selects from every selector, in the order given', async () => {
    const selector = new CombinedSelector([
      new ManualDatasetSelection(datasets('a', 'b')),
      new ManualDatasetSelection(datasets('c')),
    ]);

    expect(await selectedIris(selector)).toEqual([
      'https://example.org/a',
      'https://example.org/b',
      'https://example.org/c',
    ]);
    expect((await selector.select()).total).toBe(3);
  });

  it('selects the same again on a second iteration', async () => {
    const paginator = await new CombinedSelector([
      new ManualDatasetSelection(datasets('a')),
      new ManualDatasetSelection(datasets('b')),
    ]).select();

    const read = async () => {
      const iris = [];
      for await (const dataset of paginator) {
        iris.push(dataset.iri.toString());
      }
      return iris;
    };

    expect(await read()).toEqual(await read());
    expect(await read()).toHaveLength(2);
  });

  it('selects nothing from nothing', async () => {
    expect(await selectedIris(new CombinedSelector([]))).toEqual([]);
  });

  it('reads a selector one page at a time', async () => {
    const all = datasets(...Array.from({ length: 2500 }, (_, i) => `${i}`));
    const fetchPage = vi.fn(async (offset: number, limit: number) =>
      all.slice(offset, offset + limit),
    );
    const paged: DatasetSelector = {
      select: async () => new Paginator(fetchPage, all.length),
    };

    const iterator = (await new CombinedSelector([paged]).select())[
      Symbol.asyncIterator
    ]();

    await iterator.next();
    expect(fetchPage).toHaveBeenCalledTimes(1);

    let count = 1;
    while (!(await iterator.next()).done) {
      count++;
    }
    expect(count).toBe(all.length);
    expect(fetchPage).toHaveBeenCalledTimes(3);
  });

  it('rejects when a selector does', async () => {
    const failing: DatasetSelector = {
      select: () => Promise.reject(new Error('registry down')),
    };

    await expect(
      new CombinedSelector([
        new ManualDatasetSelection(datasets('a')),
        failing,
      ]).select(),
    ).rejects.toThrow('registry down');
  });
});
