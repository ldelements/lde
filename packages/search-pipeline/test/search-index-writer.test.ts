import { describe, expect, it, vi } from 'vitest';
import { DataFactory } from 'n3';
import type { Quad } from '@rdfjs/types';
import { Dataset } from '@lde/dataset';
import type { RunContext, RunWriter, Writer } from '@lde/pipeline';
import { searchSchema, type SearchDocument } from '@lde/search';
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

function personQuads(iri: string, name: string): Quad[] {
  return [
    quad(namedNode(iri), namedNode(RDF_TYPE), namedNode(PERSON)),
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

/** A fake engine writer capturing every per-dataset document write. */
function makeEngineWriter() {
  const writes: { dataset: Dataset; documents: SearchDocument[] }[] = [];
  const runWriter = {
    write: vi.fn(
      async (written: Dataset, documents: AsyncIterable<SearchDocument>) => {
        const collected: SearchDocument[] = [];
        for await (const document of documents) {
          collected.push(document);
        }
        writes.push({ dataset: written, documents: collected });
      },
    ),
    flush: vi.fn().mockResolvedValue(undefined),
    reset: vi.fn().mockResolvedValue(undefined),
    commit: vi.fn().mockResolvedValue(undefined),
    abort: vi.fn().mockResolvedValue(undefined),
  };
  const writer: Writer<SearchDocument> & {
    openRun: ReturnType<typeof vi.fn>;
  } = {
    openRun: vi.fn().mockResolvedValue(runWriter),
  };
  return { writer, runWriter, writes };
}

async function openRun(
  engine: ReturnType<typeof makeEngineWriter>,
): Promise<RunWriter<Quad>> {
  return searchIndexWriter({ schema, writer: engine.writer }).openRun(
    makeRunContext(),
  );
}

describe('searchIndexWriter', () => {
  it('projects a dataset’s quads into documents and writes them to the engine on flush', async () => {
    const engine = makeEngineWriter();
    const run = await openRun(engine);

    await run.write(
      dataset,
      stream([
        ...personQuads('http://example.org/person/1', 'Alice'),
        ...personQuads('http://example.org/person/2', 'Bob'),
      ]),
    );
    await run.flush?.(dataset, 'success');

    expect(engine.writes).toHaveLength(1);
    expect(engine.writes[0].dataset).toBe(dataset);
    expect(engine.writes[0].documents).toEqual([
      { id: 'http://example.org/person/1', name: ['Alice'] },
      { id: 'http://example.org/person/2', name: ['Bob'] },
    ]);
    expect(engine.runWriter.flush).toHaveBeenCalledExactlyOnceWith(
      dataset,
      'success',
    );
  });

  it('projects every root type in the schema', async () => {
    const engine = makeEngineWriter();
    const run = await openRun(engine);

    await run.write(
      dataset,
      stream([
        ...personQuads('http://example.org/person/1', 'Alice'),
        quad(
          namedNode('http://example.org/work/1'),
          namedNode(RDF_TYPE),
          namedNode(WORK),
        ),
        quad(
          namedNode('http://example.org/work/1'),
          namedNode(NAME),
          literal('Nachtwacht'),
        ),
      ]),
    );
    await run.flush?.(dataset, 'success');

    const ids = engine.writes[0].documents.map((document) => document.id);
    expect(ids).toContain('http://example.org/person/1');
    expect(ids).toContain('http://example.org/work/1');
  });

  it('combines multiple writes for one dataset into a single projection', async () => {
    // A dataset writes once per stage; all stages’ quads project together.
    const engine = makeEngineWriter();
    const run = await openRun(engine);

    await run.write(
      dataset,
      stream(personQuads('http://example.org/person/1', 'Alice')),
    );
    await run.write(
      dataset,
      stream(personQuads('http://example.org/person/2', 'Bob')),
    );
    await run.flush?.(dataset, 'success');

    expect(engine.writes).toHaveLength(1);
    expect(engine.writes[0].documents.map((document) => document.id)).toEqual([
      'http://example.org/person/1',
      'http://example.org/person/2',
    ]);
  });

  it('does not accumulate quads across dataset flushes', async () => {
    const engine = makeEngineWriter();
    const run = await openRun(engine);

    await run.write(
      dataset,
      stream(personQuads('http://example.org/person/1', 'Alice')),
    );
    await run.flush?.(dataset, 'success');
    await run.write(
      dataset,
      stream(personQuads('http://example.org/person/2', 'Bob')),
    );
    await run.flush?.(dataset, 'success');

    expect(engine.writes).toHaveLength(2);
    expect(engine.writes[1].documents.map((document) => document.id)).toEqual([
      'http://example.org/person/2',
    ]);
  });

  it('forwards a flush without any writes, but writes no documents', async () => {
    const engine = makeEngineWriter();
    const run = await openRun(engine);

    await run.flush?.(dataset, 'success');

    expect(engine.runWriter.write).not.toHaveBeenCalled();
    expect(engine.runWriter.flush).toHaveBeenCalledExactlyOnceWith(
      dataset,
      'success',
    );
  });

  it('writes no documents for a dataset whose extraction was empty', async () => {
    const engine = makeEngineWriter();
    const run = await openRun(engine);

    await run.write(dataset, stream([]));
    await run.flush?.(dataset, 'success');

    expect(engine.runWriter.write).not.toHaveBeenCalled();
    expect(engine.runWriter.flush).toHaveBeenCalledOnce();
  });

  it('reset discards the buffered pass and forwards to the engine', async () => {
    const engine = makeEngineWriter();
    const run = await openRun(engine);

    await run.write(
      dataset,
      stream(personQuads('http://example.org/person/1', 'Endpoint pass')),
    );
    await run.reset?.(dataset);
    await run.write(
      dataset,
      stream(personQuads('http://example.org/person/1', 'Dump pass')),
    );
    await run.flush?.(dataset, 'success');

    expect(engine.runWriter.reset).toHaveBeenCalledExactlyOnceWith(dataset);
    expect(engine.writes).toHaveLength(1);
    expect(engine.writes[0].documents).toEqual([
      { id: 'http://example.org/person/1', name: ['Dump pass'] },
    ]);
  });

  it('projects never-flushed leftovers on commit, then commits the engine run', async () => {
    const engine = makeEngineWriter();
    const run = await openRun(engine);

    await run.write(
      dataset,
      stream(personQuads('http://example.org/person/1', 'Alice')),
    );
    await run.commit();

    expect(engine.writes).toHaveLength(1);
    expect(engine.runWriter.commit).toHaveBeenCalledOnce();
  });

  it('tolerates an engine writer without flush and reset', async () => {
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
      writer: minimalEngine,
    }).openRun(makeRunContext());

    await run.write(
      dataset,
      stream(personQuads('http://example.org/person/1', 'Alice')),
    );
    await run.reset?.(dataset);
    await run.write(
      dataset,
      stream(personQuads('http://example.org/person/1', 'Alice')),
    );
    await run.flush?.(dataset, 'success');

    expect(written).toHaveLength(1);
  });

  it('forwards abort with the run failure', async () => {
    const engine = makeEngineWriter();
    const run = await openRun(engine);
    const failure = new Error('selection died');

    await run.abort(failure);

    expect(engine.runWriter.abort).toHaveBeenCalledExactlyOnceWith(failure);
  });

  it('opens the engine run with the pipeline’s run context', async () => {
    const engine = makeEngineWriter();
    const context = makeRunContext();

    await searchIndexWriter({ schema, writer: engine.writer }).openRun(context);

    expect(engine.writer.openRun).toHaveBeenCalledExactlyOnceWith(context);
  });
});
