import { describe, expect, it, vi, type Mock } from 'vitest';
import { Dataset } from '@lde/dataset';
import type { RunContext, RunWriter, Writer } from '@lde/pipeline';
import {
  searchSchema,
  type SearchDocument,
  type SearchType,
} from '@lde/search';
import { searchIndexWriter } from '../src/search-index-writer.js';
import type { TypedSearchDocument } from '../src/typed-search-document.js';

const PERSON = 'https://example.org/Person';
const WORK = 'https://example.org/CreativeWork';

const schema = searchSchema(
  {
    name: 'person',
    class: PERSON,
    fields: [
      { name: 'name', kind: 'keyword', path: 'https://example.org/name' },
    ],
  },
  {
    name: 'work',
    class: WORK,
    fields: [
      { name: 'name', kind: 'keyword', path: 'https://example.org/name' },
    ],
  },
);

/** The schema’s own declaration object for a class (identity matters). */
function typeOf(classIri: string): SearchType {
  const searchType = schema.get(classIri);
  if (searchType === undefined) {
    throw new Error(`no such type: ${classIri}`);
  }
  return searchType;
}

const dataset = new Dataset({
  iri: new URL('http://example.org/dataset/1'),
  distributions: [],
});

/** A tagged document, as a per-type stage would emit it. */
function typed(
  classIri: string,
  id: string,
  name: string,
): TypedSearchDocument {
  return { searchType: typeOf(classIri), document: { id, name: [name] } };
}

async function* stream<Item>(items: readonly Item[]): AsyncIterable<Item> {
  yield* items;
}

function makeRunContext(): RunContext {
  return {
    runId: 'run-1',
    startedAt: '2026-07-06T12:00:00.000Z',
    selectedSources: () => [dataset.iri.toString()],
  };
}

/** One fake engine collection: records every lifecycle call routed to it. */
interface FakeCollection {
  readonly searchType: SearchType;
  readonly writes: { dataset: Dataset; documents: SearchDocument[] }[];
  readonly flushes: { dataset: Dataset; outcome: string }[];
  readonly resets: Dataset[];
  readonly commit: Mock<() => Promise<void>>;
  readonly abort: Mock<(error: unknown) => Promise<void>>;
  openRunCalls: number;
}

/**
 * A fleet of fake per-type engine writers, one built per {@link SearchType} the
 * writer asks for. Each records the writes/flushes/lifecycle calls routed to
 * its collection, so a test can assert the fan-out by type.
 */
function makeFleet(
  overrides: {
    commit?: (searchType: SearchType) => Promise<void>;
    flush?: (searchType: SearchType) => Promise<void>;
    reset?: (searchType: SearchType) => Promise<void>;
    write?: (searchType: SearchType) => Promise<void>;
  } = {},
) {
  const collections = new Map<string, FakeCollection>();
  const commitOverride = overrides.commit;

  const writerFor = (searchType: SearchType): Writer<SearchDocument> => {
    const collection: FakeCollection = {
      searchType,
      writes: [],
      flushes: [],
      resets: [],
      commit: vi.fn<() => Promise<void>>(
        commitOverride
          ? () => commitOverride(searchType)
          : () => Promise.resolve(),
      ),
      abort: vi.fn<(error: unknown) => Promise<void>>().mockResolvedValue(),
      openRunCalls: 0,
    };
    collections.set(searchType.class, collection);

    const runWriter: RunWriter<SearchDocument> = {
      write: async (written, documents) => {
        const collected: SearchDocument[] = [];
        for await (const document of documents) {
          collected.push(document);
        }
        collection.writes.push({ dataset: written, documents: collected });
        await overrides.write?.(searchType);
      },
      // Record the call first, then run any injected failure, so a test can
      // assert every collection was reached even when one of them throws.
      flush: async (written, outcome) => {
        collection.flushes.push({ dataset: written, outcome });
        await overrides.flush?.(searchType);
      },
      reset: async (written) => {
        collection.resets.push(written);
        await overrides.reset?.(searchType);
      },
      commit: () => collection.commit(),
      abort: (error) => collection.abort(error),
    };

    return {
      openRun: async () => {
        collection.openRunCalls += 1;
        return runWriter;
      },
    };
  };

  return { writerFor, collections };
}

function openRun(
  fleet: ReturnType<typeof makeFleet>,
): Promise<RunWriter<TypedSearchDocument>> {
  return searchIndexWriter({ schema, writerFor: fleet.writerFor }).openRun(
    makeRunContext(),
  );
}

/** The fake collection built for a type (present once the run has opened). */
function collectionOf(
  fleet: ReturnType<typeof makeFleet>,
  type: string,
): FakeCollection {
  return fleet.collections.get(type) as FakeCollection;
}

const ids = (documents: SearchDocument[]) =>
  documents.map((document) => document.id);

describe('searchIndexWriter', () => {
  it('routes each type’s documents to its own collection', async () => {
    const fleet = makeFleet();
    const run = await openRun(fleet);

    await run.write(
      dataset,
      stream([
        typed(PERSON, 'http://example.org/person/1', 'Alice'),
        typed(WORK, 'http://example.org/work/1', 'Nachtwacht'),
      ]),
    );
    await run.flush?.(dataset, 'success');

    const person = collectionOf(fleet, PERSON);
    const work = collectionOf(fleet, WORK);
    expect(ids(person.writes.flatMap((write) => write.documents))).toEqual([
      'http://example.org/person/1',
    ]);
    expect(ids(work.writes.flatMap((write) => write.documents))).toEqual([
      'http://example.org/work/1',
    ]);
  });

  it('builds one engine writer per type and opens each once', async () => {
    const fleet = makeFleet();
    await openRun(fleet);

    expect([...fleet.collections.keys()].sort()).toEqual([PERSON, WORK].sort());
    for (const collection of fleet.collections.values()) {
      expect(collection.openRunCalls).toBe(1);
    }
  });

  it('streams every document of one write straight to its run', async () => {
    const fleet = makeFleet();
    const run = await openRun(fleet);

    await run.write(
      dataset,
      stream([
        typed(PERSON, 'http://example.org/person/1', 'Alice'),
        typed(PERSON, 'http://example.org/person/2', 'Bob'),
      ]),
    );
    await run.flush?.(dataset, 'success');

    const person = collectionOf(fleet, PERSON);
    // One write call, one lane, both documents delivered in order.
    expect(person.writes).toHaveLength(1);
    expect(ids(person.writes[0].documents)).toEqual([
      'http://example.org/person/1',
      'http://example.org/person/2',
    ]);
  });

  it('delivers documents from separate write calls independently', async () => {
    const fleet = makeFleet();
    const run = await openRun(fleet);

    await run.write(
      dataset,
      stream([typed(PERSON, 'http://example.org/person/1', 'Alice')]),
    );
    await run.write(
      dataset,
      stream([typed(PERSON, 'http://example.org/person/2', 'Bob')]),
    );
    await run.flush?.(dataset, 'success');

    const person = collectionOf(fleet, PERSON);
    expect(person.writes).toHaveLength(2);
    expect(ids(person.writes[1].documents)).toEqual([
      'http://example.org/person/2',
    ]);
  });

  it('flushes every collection on a dataset flush, even ones with no documents', async () => {
    const fleet = makeFleet();
    const run = await openRun(fleet);

    // Only Person documents: the Work collection receives none this dataset.
    await run.write(
      dataset,
      stream([typed(PERSON, 'http://example.org/person/1', 'Alice')]),
    );
    await run.flush?.(dataset, 'success');

    const work = collectionOf(fleet, WORK);
    expect(work.writes).toHaveLength(0);
    // …but still gets its flush, so an In-place stale sweep can reconcile.
    expect(work.flushes).toEqual([{ dataset, outcome: 'success' }]);
  });

  it('forwards a flush that had no writes to every collection', async () => {
    const fleet = makeFleet();
    const run = await openRun(fleet);

    await run.flush?.(dataset, 'success');

    for (const collection of fleet.collections.values()) {
      expect(collection.writes).toHaveLength(0);
      expect(collection.flushes).toEqual([{ dataset, outcome: 'success' }]);
    }
  });

  it('writes nothing for an empty document stream, but still flushes', async () => {
    const fleet = makeFleet();
    const run = await openRun(fleet);

    await run.write(dataset, stream<TypedSearchDocument>([]));
    await run.flush?.(dataset, 'success');

    for (const collection of fleet.collections.values()) {
      expect(collection.writes).toHaveLength(0);
      expect(collection.flushes).toEqual([{ dataset, outcome: 'success' }]);
    }
  });

  it('rejects a document whose type is not in the writer’s schema', async () => {
    const fleet = makeFleet();
    const run = await openRun(fleet);
    const foreign: TypedSearchDocument = {
      searchType: {
        name: 'Ghost',
        class: 'https://example.org/Ghost',
        fields: [],
      },
      document: { id: 'x' },
    };

    await expect(run.write(dataset, stream([foreign]))).rejects.toThrow(
      /not in this writer’s schema/,
    );
  });

  it('surfaces a run’s write failure rather than swallowing it', async () => {
    const failure = new Error('import failed');
    const fleet = makeFleet({
      write: (searchType) =>
        searchType.class === PERSON
          ? Promise.reject(failure)
          : Promise.resolve(),
    });
    const run = await openRun(fleet);

    await expect(
      run.write(
        dataset,
        stream([typed(PERSON, 'http://example.org/person/1', 'Alice')]),
      ),
    ).rejects.toBe(failure);
  });

  it('flushes every collection even when one collection’s flush fails, then surfaces it', async () => {
    const failure = new Error('person rollback failed');
    const fleet = makeFleet({
      flush: (searchType) =>
        searchType.class === PERSON
          ? Promise.reject(failure)
          : Promise.resolve(),
    });
    const run = await openRun(fleet);

    await expect(run.flush?.(dataset, 'failed')).rejects.toThrow(
      AggregateError,
    );

    expect(collectionOf(fleet, WORK).flushes).toEqual([
      { dataset, outcome: 'failed' },
    ]);
    expect(collectionOf(fleet, PERSON).flushes).toEqual([
      { dataset, outcome: 'failed' },
    ]);
  });

  it('resets every collection even when one collection’s reset fails, then surfaces it', async () => {
    const failure = new Error('person reset failed');
    const fleet = makeFleet({
      reset: (searchType) =>
        searchType.class === PERSON
          ? Promise.reject(failure)
          : Promise.resolve(),
    });
    const run = await openRun(fleet);

    await expect(run.reset?.(dataset)).rejects.toThrow(AggregateError);

    expect(collectionOf(fleet, WORK).resets).toEqual([dataset]);
    expect(collectionOf(fleet, PERSON).resets).toEqual([dataset]);
  });

  it('reset forwards to every collection', async () => {
    const fleet = makeFleet();
    const run = await openRun(fleet);

    await run.reset?.(dataset);

    expect(collectionOf(fleet, PERSON).resets).toEqual([dataset]);
    expect(collectionOf(fleet, WORK).resets).toEqual([dataset]);
  });

  it('commits every collection', async () => {
    const fleet = makeFleet();
    const run = await openRun(fleet);

    await run.write(
      dataset,
      stream([typed(PERSON, 'http://example.org/person/1', 'Alice')]),
    );
    await run.commit();

    expect(collectionOf(fleet, PERSON).commit).toHaveBeenCalledOnce();
    expect(collectionOf(fleet, WORK).commit).toHaveBeenCalledOnce();
  });

  it('commits every collection independently and aggregates the failures', async () => {
    const failure = new Error('work collection swap failed');
    const fleet = makeFleet({
      commit: (searchType) =>
        searchType.class === WORK ? Promise.reject(failure) : Promise.resolve(),
    });
    const run = await openRun(fleet);

    await expect(run.commit()).rejects.toThrow(AggregateError);

    expect(collectionOf(fleet, PERSON).commit).toHaveBeenCalledOnce();
    expect(collectionOf(fleet, WORK).commit).toHaveBeenCalledOnce();
  });

  it('abort after a partial commit finalizes only the collections that did not go live', async () => {
    const failure = new Error('work collection swap failed');
    const fleet = makeFleet({
      commit: (searchType) =>
        searchType.class === WORK ? Promise.reject(failure) : Promise.resolve(),
    });
    const run = await openRun(fleet);

    await expect(run.commit()).rejects.toThrow(AggregateError);
    // The pipeline aborts the run after commit throws.
    await run.abort(failure);

    // Person committed live: aborting it would drop its now-live collection.
    expect(collectionOf(fleet, PERSON).abort).not.toHaveBeenCalled();
    // Work never went live, so it is finalized (its half-built collection
    // dropped, its lock released).
    expect(collectionOf(fleet, WORK).abort).toHaveBeenCalledOnce();
  });

  it('rolls back already-opened collections when a later openRun fails', async () => {
    const opened: SearchType[] = [];
    const aborted: SearchType[] = [];
    const failure = new Error('lock held');
    const writerFor = (searchType: SearchType): Writer<SearchDocument> => ({
      openRun: async () => {
        // The second type to open fails; the first must be rolled back.
        if (opened.length === 1) {
          throw failure;
        }
        opened.push(searchType);
        return {
          write: () => Promise.resolve(),
          commit: () => Promise.resolve(),
          abort: async () => {
            aborted.push(searchType);
          },
        };
      },
    });

    await expect(
      searchIndexWriter({ schema, writerFor }).openRun(makeRunContext()),
    ).rejects.toBe(failure);
    // Exactly the one opened run was aborted; no run leaks its lock.
    expect(aborted).toHaveLength(1);
    expect(aborted[0]).toBe(opened[0]);
  });

  it('forwards abort with the run failure to every collection', async () => {
    const fleet = makeFleet();
    const run = await openRun(fleet);
    const failure = new Error('selection died');

    await run.abort(failure);

    for (const collection of fleet.collections.values()) {
      expect(collection.abort).toHaveBeenCalledExactlyOnceWith(failure);
    }
  });

  it('tolerates engine writers without flush and reset', async () => {
    const written: SearchDocument[] = [];
    const minimalEngine: Writer<SearchDocument> = {
      openRun: async () => ({
        write: async (_dataset, documents) => {
          for await (const document of documents) {
            written.push(document);
          }
        },
        commit: () => Promise.resolve(),
        abort: () => Promise.resolve(),
      }),
    };
    const run = await searchIndexWriter({
      schema,
      writerFor: () => minimalEngine,
    }).openRun(makeRunContext());

    await run.write(
      dataset,
      stream([typed(PERSON, 'http://example.org/person/1', 'Alice')]),
    );
    await run.reset?.(dataset);
    await run.write(
      dataset,
      stream([typed(PERSON, 'http://example.org/person/1', 'Alice')]),
    );
    await run.flush?.(dataset, 'success');

    expect(written).toHaveLength(2);
  });

  it('opens every collection’s run with the pipeline’s run context', async () => {
    const contexts: RunContext[] = [];
    const writerFor = (): Writer<SearchDocument> => ({
      openRun: async (context) => {
        contexts.push(context);
        return {
          write: () => Promise.resolve(),
          commit: () => Promise.resolve(),
          abort: () => Promise.resolve(),
        };
      },
    });
    const context = makeRunContext();

    await searchIndexWriter({ schema, writerFor }).openRun(context);

    expect(contexts).toHaveLength(2);
    expect(contexts.every((seen) => seen === context)).toBe(true);
  });
});
