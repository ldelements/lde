import { describe, expect, it, vi, type Mock } from 'vitest';
import { DataFactory } from 'n3';
import type { Quad } from '@rdfjs/types';
import { Dataset } from '@lde/dataset';
import type { RunContext, RunWriter, Writer } from '@lde/pipeline';
import {
  searchSchema,
  type SearchDocument,
  type SearchType,
} from '@lde/search';
import { searchIndexWriter } from '../src/search-index-writer.js';

const { namedNode, literal, quad } = DataFactory;

const RDF_TYPE = 'http://www.w3.org/1999/02/22-rdf-syntax-ns#type';
const PERSON = 'https://example.org/Person';
const WORK = 'https://example.org/CreativeWork';
const NAME = 'https://example.org/name';

const schema = searchSchema(
  {
    name: 'person',
    type: PERSON,
    fields: [{ name: 'name', kind: 'keyword', path: NAME }],
  },
  {
    name: 'work',
    type: WORK,
    fields: [{ name: 'name', kind: 'keyword', path: NAME }],
  },
);

const dataset = new Dataset({
  iri: new URL('http://example.org/dataset/1'),
  distributions: [],
});

function typedQuads(iri: string, type: string, name: string): Quad[] {
  return [
    quad(namedNode(iri), namedNode(RDF_TYPE), namedNode(type)),
    quad(namedNode(iri), namedNode(NAME), literal(name)),
  ];
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
    collections.set(searchType.type, collection);

    const runWriter: RunWriter<SearchDocument> = {
      write: async (written, documents) => {
        const collected: SearchDocument[] = [];
        for await (const document of documents) {
          collected.push(document);
        }
        collection.writes.push({ dataset: written, documents: collected });
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
): Promise<RunWriter<Quad>> {
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
  it('routes each type’s documents to its own collection on flush', async () => {
    const fleet = makeFleet();
    const run = await openRun(fleet);

    await run.write(
      dataset,
      stream([
        ...typedQuads('http://example.org/person/1', PERSON, 'Alice'),
        ...typedQuads('http://example.org/work/1', WORK, 'Nachtwacht'),
      ]),
    );
    await run.flush?.(dataset, 'success');

    const person = collectionOf(fleet, PERSON);
    const work = collectionOf(fleet, WORK);
    expect(person.writes).toHaveLength(1);
    expect(ids(person.writes[0].documents)).toEqual([
      'http://example.org/person/1',
    ]);
    expect(work.writes).toHaveLength(1);
    expect(ids(work.writes[0].documents)).toEqual([
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

  it('combines multiple writes for one dataset into a single projection', async () => {
    const fleet = makeFleet();
    const run = await openRun(fleet);

    await run.write(
      dataset,
      stream(typedQuads('http://example.org/person/1', PERSON, 'Alice')),
    );
    await run.write(
      dataset,
      stream(typedQuads('http://example.org/person/2', PERSON, 'Bob')),
    );
    await run.flush?.(dataset, 'success');

    const person = collectionOf(fleet, PERSON);
    expect(person.writes).toHaveLength(1);
    expect(ids(person.writes[0].documents)).toEqual([
      'http://example.org/person/1',
      'http://example.org/person/2',
    ]);
  });

  it('does not accumulate quads across dataset flushes', async () => {
    const fleet = makeFleet();
    const run = await openRun(fleet);

    await run.write(
      dataset,
      stream(typedQuads('http://example.org/person/1', PERSON, 'Alice')),
    );
    await run.flush?.(dataset, 'success');
    await run.write(
      dataset,
      stream(typedQuads('http://example.org/person/2', PERSON, 'Bob')),
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

    // Only Person quads: the Work collection receives no documents this dataset.
    await run.write(
      dataset,
      stream(typedQuads('http://example.org/person/1', PERSON, 'Alice')),
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

  it('writes no documents for a dataset whose extraction was empty, but still flushes', async () => {
    const fleet = makeFleet();
    const run = await openRun(fleet);

    await run.write(dataset, stream<Quad>([]));
    await run.flush?.(dataset, 'success');

    for (const collection of fleet.collections.values()) {
      expect(collection.writes).toHaveLength(0);
      expect(collection.flushes).toEqual([{ dataset, outcome: 'success' }]);
    }
  });

  it('flushes every collection even when one collection’s flush fails, then surfaces it', async () => {
    // The Person collection's flush (e.g. a rollback of a failed dataset)
    // throws; the Work collection must still be flushed, not skipped.
    const failure = new Error('person rollback failed');
    const fleet = makeFleet({
      flush: (searchType) =>
        searchType.type === PERSON
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
        searchType.type === PERSON
          ? Promise.reject(failure)
          : Promise.resolve(),
    });
    const run = await openRun(fleet);

    await expect(run.reset?.(dataset)).rejects.toThrow(AggregateError);

    expect(collectionOf(fleet, WORK).resets).toEqual([dataset]);
    expect(collectionOf(fleet, PERSON).resets).toEqual([dataset]);
  });

  it('reset discards the buffered pass and forwards to every collection', async () => {
    const fleet = makeFleet();
    const run = await openRun(fleet);

    await run.write(
      dataset,
      stream(typedQuads('http://example.org/person/1', PERSON, 'Endpoint')),
    );
    await run.reset?.(dataset);
    await run.write(
      dataset,
      stream(typedQuads('http://example.org/person/1', PERSON, 'Dump')),
    );
    await run.flush?.(dataset, 'success');

    const person = collectionOf(fleet, PERSON);
    expect(person.resets).toEqual([dataset]);
    expect(collectionOf(fleet, WORK).resets).toEqual([dataset]);
    expect(person.writes).toHaveLength(1);
    expect(person.writes[0].documents).toEqual([
      { id: 'http://example.org/person/1', name: ['Dump'] },
    ]);
  });

  it('projects never-flushed leftovers on commit, then commits every collection', async () => {
    const fleet = makeFleet();
    const run = await openRun(fleet);

    await run.write(
      dataset,
      stream(typedQuads('http://example.org/person/1', PERSON, 'Alice')),
    );
    await run.commit();

    const person = collectionOf(fleet, PERSON);
    expect(person.writes).toHaveLength(1);
    expect(person.commit).toHaveBeenCalledOnce();
    expect(collectionOf(fleet, WORK).commit).toHaveBeenCalledOnce();
  });

  it('commits every collection independently and aggregates the failures', async () => {
    // The Work collection’s commit fails; the Person collection must still go
    // live, and the failure must surface as an AggregateError.
    const failure = new Error('work collection swap failed');
    const fleet = makeFleet({
      commit: (searchType) =>
        searchType.type === WORK ? Promise.reject(failure) : Promise.resolve(),
    });
    const run = await openRun(fleet);

    await expect(run.commit()).rejects.toThrow(AggregateError);

    const person = collectionOf(fleet, PERSON);
    const work = collectionOf(fleet, WORK);
    expect(person.commit).toHaveBeenCalledOnce();
    expect(work.commit).toHaveBeenCalledOnce();
  });

  it('abort after a partial commit finalizes only the collections that did not go live', async () => {
    const failure = new Error('work collection swap failed');
    const fleet = makeFleet({
      commit: (searchType) =>
        searchType.type === WORK ? Promise.reject(failure) : Promise.resolve(),
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
      stream(typedQuads('http://example.org/person/1', PERSON, 'Alice')),
    );
    await run.reset?.(dataset);
    await run.write(
      dataset,
      stream(typedQuads('http://example.org/person/1', PERSON, 'Alice')),
    );
    await run.flush?.(dataset, 'success');

    expect(written).toHaveLength(1);
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
