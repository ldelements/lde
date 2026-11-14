import { describe, expect, it } from 'vitest';
import {
  defineSearchType,
  searchSchema,
  type ReferenceField,
  type SearchType,
} from '@lde/search';
import { GroupLock, importLockFor } from '../src/import-lock.js';

/** A task that runs until its test lets it finish. */
function pending() {
  let finish!: () => void;
  const finished = new Promise<void>((resolve) => {
    finish = resolve;
  });
  return { finish, task: () => finished };
}

/** Let every already-settled promise’s continuation run. */
const settle = () => new Promise((resolve) => setImmediate(resolve));

/** Which of `labels` have started, in the order they did. */
function recorder() {
  const started: string[] = [];
  const track =
    (label: string, task: () => Promise<void>) => async (): Promise<void> => {
      started.push(label);
      await task();
    };
  return { started, track };
}

describe('GroupLock', () => {
  it('runs tasks of one group concurrently', async () => {
    const lock = new GroupLock();
    const { started, track } = recorder();
    const first = pending();
    const second = pending();

    const runs = [
      lock.run('works', track('works 1', first.task)),
      lock.run('works', track('works 2', second.task)),
    ];
    await settle();
    expect(started).toEqual(['works 1', 'works 2']);

    first.finish();
    second.finish();
    await Promise.all(runs);
  });

  it('holds a task of another group until the holding group has none in flight', async () => {
    const lock = new GroupLock();
    const { started, track } = recorder();
    const first = pending();
    const second = pending();

    const runs = [
      lock.run('works', track('works 1', first.task)),
      lock.run('works', track('works 2', second.task)),
      lock.run(
        'datasets',
        track('datasets', async () => undefined),
      ),
    ];
    await settle();
    expect(started).toEqual(['works 1', 'works 2']);

    first.finish();
    await settle();
    expect(started).toEqual(['works 1', 'works 2']);

    second.finish();
    await Promise.all(runs);
    expect(started).toEqual(['works 1', 'works 2', 'datasets']);
  });

  it('queues a task of the holding group behind an earlier waiter of another', async () => {
    const lock = new GroupLock();
    const { started, track } = recorder();
    const first = pending();
    const datasets = pending();

    const runs = [
      lock.run('works', track('works 1', first.task)),
      lock.run('datasets', track('datasets', datasets.task)),
      // Would overtake the waiting datasets import, and could keep doing so
      // for as long as works keep arriving.
      lock.run(
        'works',
        track('works 2', async () => undefined),
      ),
    ];
    await settle();
    expect(started).toEqual(['works 1']);

    first.finish();
    await settle();
    expect(started).toEqual(['works 1', 'datasets']);

    datasets.finish();
    await Promise.all(runs);
    expect(started).toEqual(['works 1', 'datasets', 'works 2']);
  });

  it('admits every waiter of the next group together', async () => {
    const lock = new GroupLock();
    const { started, track } = recorder();
    const first = pending();
    const waiting = pending();

    const runs = [
      lock.run('works', track('works', first.task)),
      lock.run('datasets', track('datasets 1', waiting.task)),
      lock.run(
        'publishers',
        track('publishers', async () => undefined),
      ),
      lock.run('datasets', track('datasets 2', waiting.task)),
    ];
    first.finish();
    await settle();
    expect(started).toEqual(['works', 'datasets 1', 'datasets 2']);

    waiting.finish();
    await Promise.all(runs);
    expect(started).toEqual([
      'works',
      'datasets 1',
      'datasets 2',
      'publishers',
    ]);
  });

  it('releases the lock when a task fails', async () => {
    const lock = new GroupLock();
    await expect(
      lock.run('works', async () => {
        throw new Error('import failed');
      }),
    ).rejects.toThrow('import failed');
    await expect(lock.run('datasets', async () => 'imported')).resolves.toBe(
      'imported',
    );
  });
});

describe('importLockFor', () => {
  const type = (name: string, fields: SearchType['fields'] = []) =>
    defineSearchType({
      name,
      class: `https://example.org/${name}`,
      fields: [
        {
          name: 'label',
          path: 'http://www.w3.org/2000/01/rdf-schema#label',
          kind: 'text',
          locales: ['nl'],
          output: true,
          searchable: { weight: 5 },
        },
        ...fields,
      ],
    });
  const joinable = (name: string, source: string): ReferenceField => ({
    name,
    path: `https://example.org/${name}`,
    kind: 'reference',
    labelSource: source,
    joinable: true,
  });
  const publisher = type('Publisher');
  const dataset = type('Dataset', [joinable('publisher', 'Publisher')]);
  const place = type('Place');
  const schema = searchSchema(publisher, dataset, place);

  /** Whether an import into `waiter`’s collection starts while one into
   *  `holder`’s is in flight. */
  const overlaps = async (holder: SearchType, waiter: SearchType) => {
    const held = pending();
    let started = false;
    const holding = importLockFor(holder, schema)(held.task);
    const waiting = importLockFor(
      waiter,
      schema,
    )(async () => {
      started = true;
    });
    await settle();
    const overlapped = started;
    held.finish();
    await Promise.all([holding, waiting]);
    return overlapped;
  };

  it('serialises imports across the collections of one join component', async () => {
    expect(await overlaps(publisher, dataset)).toBe(false);
    expect(await overlaps(dataset, publisher)).toBe(false);
  });

  it('never holds back a collection outside the component', async () => {
    expect(await overlaps(dataset, place)).toBe(true);
    expect(await overlaps(place, publisher)).toBe(true);
  });

  it('never holds back a type written without a schema', async () => {
    const held = pending();
    const holding = importLockFor(publisher, schema)(held.task);
    await expect(
      importLockFor(dataset, undefined)(async () => 'imported'),
    ).resolves.toBe('imported');
    held.finish();
    await holding;
  });
});
