import { Dataset } from '@lde/dataset';
import { type Client, Paginator } from '@lde/dataset-registry-client';
import { describe, expect, it, vi } from 'vitest';
import {
  CombinedSelector,
  ManualDatasetSelection,
  RegistrySelector,
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

describe('RegistrySelector', () => {
  function registry() {
    const query = vi.fn(async () => new Paginator(async () => [], 0));
    return { client: { query } as unknown as Client, query };
  }

  it('selects by criteria, or every dataset without any', async () => {
    const { client, query } = registry();

    await new RegistrySelector({ registry: client }).select();
    await new RegistrySelector({
      registry: client,
      criteria: { $id: ['https://example.org/a'] },
    }).select();

    expect(query).toHaveBeenNthCalledWith(1, {});
    expect(query).toHaveBeenNthCalledWith(2, {
      $id: ['https://example.org/a'],
    });
  });

  it('selects by a custom query when given one', async () => {
    const { client, query } = registry();

    await new RegistrySelector({
      registry: client,
      query: 'CONSTRUCT {} WHERE {}',
    }).select();

    expect(query).toHaveBeenCalledWith('CONSTRUCT {} WHERE {}');
  });
});

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

  it('keeps interleaved iterations apart', async () => {
    const paginator = await new CombinedSelector([
      new ManualDatasetSelection(datasets('a', 'b')),
      new ManualDatasetSelection(datasets('c')),
    ]).select();

    const first = paginator[Symbol.asyncIterator]();
    const second = paginator[Symbol.asyncIterator]();
    const read = async (iterator: AsyncIterator<Dataset>) => {
      const iris = [];
      for (let next = await iterator.next(); !next.done;) {
        iris.push(next.value.iri.toString());
        next = await iterator.next();
      }
      return iris;
    };
    await first.next();

    expect(await read(second)).toHaveLength(3);
    expect(await read(first)).toHaveLength(2);
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
