import { describe, expect, it } from 'vitest';
import { defineSearchType, searchSchema, type SearchType } from '@lde/search';
import { stream } from './helpers.js';
import type { CollectionFieldSchema } from 'typesense/lib/Typesense/Collection.js';
import type { Client } from 'typesense';
import { Dataset } from '@lde/dataset';
import {
  assertBookkeepingPresent,
  assertWritableType,
  openDocuments,
  withBookkeeping,
} from '../src/documents.js';

const typeWith = (...fields: object[]): SearchType => ({
  name: 'Object',
  class: 'https://example.org/Object',
  fields: fields as SearchType['fields'],
});

/** The same type, keyed on a canonical identifier several datasets can share. */
const keyedTypeWith = (...fields: object[]): SearchType => ({
  name: 'Object',
  class: 'https://example.org/Object',
  key: { field: 'sameAs' },
  fields: [
    { name: 'sameAs', kind: 'reference', path: 'owl:sameAs', array: true },
    ...fields,
  ] as SearchType['fields'],
});

describe('assertWritableType', () => {
  it('accepts a type declaring no dataset field at all', () => {
    expect(() =>
      assertWritableType(typeWith({ name: 'title', kind: 'keyword' }), {
        requireFacetable: true,
      }),
    ).not.toThrow();
  });

  it('rejects a type declaring a reserved bookkeeping field, naming every clash', () => {
    expect(() =>
      assertWritableType(
        typeWith(
          { name: 'title', kind: 'keyword' },
          { name: 'source', kind: 'keyword' },
          { name: 'last_seen', kind: 'keyword' },
        ),
        { requireFacetable: true },
      ),
    ).toThrow(/reserved bookkeeping field\(s\) “source”, “last_seen”/);
  });

  it('reserves the membership field on a keyed type instead', () => {
    expect(() =>
      assertWritableType(
        keyedTypeWith({ name: 'referenced_by', kind: 'keyword' }),
        {
          requireFacetable: true,
        },
      ),
    ).toThrow(/reserved bookkeeping field\(s\) “referenced_by”/);
    // `source` is not this regime's column, so it is an ordinary field name.
    expect(() =>
      assertWritableType(keyedTypeWith({ name: 'source', kind: 'keyword' }), {
        requireFacetable: true,
      }),
    ).not.toThrow();
  });

  it('rejects a dataset field on a keyed type: a shared document has no single dataset', () => {
    expect(() =>
      assertWritableType(
        keyedTypeWith({
          name: 'dataset',
          kind: 'reference',
          from: 'dataset',
          facetable: true,
        }),
        { requireFacetable: true },
      ),
    ).toThrow(/would hold whichever of them wrote it last/);
  });

  it('accepts a facetable, single-valued declaration on an unkeyed type', () => {
    expect(() =>
      assertWritableType(
        typeWith({
          name: 'dataset',
          kind: 'reference',
          from: 'dataset',
          facetable: true,
        }),
        { requireFacetable: true },
      ),
    ).not.toThrow();
  });

  it('ignores an internal dataset field: the projection prunes it before the writer', () => {
    expect(() =>
      assertWritableType(
        typeWith({ name: 'dataset', kind: 'reference', from: 'dataset' }),
        { requireFacetable: true },
      ),
    ).not.toThrow();
  });

  it('rejects an array declaration, which a membership sweep would over-delete by', () => {
    expect(() =>
      assertWritableType(
        typeWith({
          name: 'dataset',
          kind: 'reference',
          from: 'dataset',
          array: true,
          facetable: true,
        }),
        { requireFacetable: true },
      ),
    ).toThrow(/array/);
  });

  it('rejects a transform, which would stop the stored value matching the selection', () => {
    expect(() =>
      assertWritableType(
        typeWith({
          name: 'dataset',
          kind: 'reference',
          from: 'dataset',
          facetable: true,
          transform: (value: string) => value.replace('https://', 'http://'),
        }),
        { requireFacetable: true },
      ),
    ).toThrow(/transform/);
  });

  it('requires facetable only where the writer enumerates the indexed datasets', () => {
    const notFacetable = typeWith({
      name: 'dataset',
      kind: 'reference',
      from: 'dataset',
      output: true,
    });

    expect(() =>
      assertWritableType(notFacetable, { requireFacetable: true }),
    ).toThrow(/facetable/);
    // Blue/green only ever filters by a known IRI, so it needs no facet.
    expect(() =>
      assertWritableType(notFacetable, { requireFacetable: false }),
    ).not.toThrow();
  });

  it('rejects a dataset field whose facet a policy narrows, where the writer enumerates by it', () => {
    // The engine would facet only the admitted datasets, so the sweep would
    // never see – and never reconcile – the ones the policy excludes.
    const dataset = defineSearchType({
      name: 'Dataset',
      class: 'https://example.org/Dataset',
      facetKeys: { only: (id) => id.startsWith('https://registry/') },
      fields: [
        {
          name: 'label',
          kind: 'text',
          locales: ['und'],
          output: true,
          searchable: { weight: 1 },
        },
      ],
    });
    const object = defineSearchType({
      name: 'Object',
      class: 'https://example.org/Object',
      fields: [
        {
          name: 'dataset',
          kind: 'reference',
          from: 'dataset',
          facetable: true,
          ref: { strategy: 'lookup', target: 'Dataset' },
        },
      ],
    });
    const schema = searchSchema(dataset, object);

    expect(() =>
      assertWritableType(object, { requireFacetable: true, schema }),
    ).toThrow(/inherits a facet policy/);
    expect(() =>
      assertWritableType(object, { requireFacetable: false, schema }),
    ).not.toThrow();
  });
});

describe('withBookkeeping', () => {
  const definition = {
    name: 'objects',
    fields: [{ name: 'title', type: 'string' as const }],
  };

  it('adds the private dataset and run columns to an unkeyed collection', () => {
    const withFields = withBookkeeping(
      definition,
      typeWith({ name: 'title', kind: 'keyword' }),
    );

    expect(withFields.fields).toEqual([
      { name: 'title', type: 'string' },
      { name: 'source', type: 'string', facet: true },
      { name: 'last_seen', type: 'string' },
    ]);
    expect(withFields.enable_nested_fields).toBeUndefined();
  });

  it('keeps a declared dataset field as the column, adding no second one', () => {
    const withFields = withBookkeeping(
      definition,
      typeWith({
        name: 'dataset',
        kind: 'reference',
        from: 'dataset',
        facetable: true,
      }),
    );

    expect(withFields.fields).toEqual([
      { name: 'title', type: 'string' },
      { name: 'last_seen', type: 'string' },
    ]);
  });

  it('gives a keyed collection its membership field, nesting enabled', () => {
    const withFields = withBookkeeping(definition, keyedTypeWith());

    expect(withFields.enable_nested_fields).toBe(true);
    expect(withFields.fields).toEqual([
      { name: 'title', type: 'string' },
      { name: 'referenced_by', type: 'object[]' },
      { name: 'referenced_by.dataset', type: 'string[]', facet: true },
      { name: 'referenced_by.run', type: 'int64[]' },
    ]);
  });
});

describe('assertBookkeepingPresent', () => {
  const fields = (...names: string[]): CollectionFieldSchema[] =>
    names.map((name) => ({ name, type: 'string' }));

  it('passes an unkeyed collection, whose columns are self-correcting', () => {
    expect(() =>
      assertBookkeepingPresent(
        typeWith({ name: 'title', kind: 'keyword' }),
        fields('title'),
        'objects',
      ),
    ).not.toThrow();
  });

  it('passes a keyed collection that already records membership', () => {
    expect(() =>
      assertBookkeepingPresent(
        keyedTypeWith(),
        fields('title', 'referenced_by.dataset'),
        'objects',
      ),
    ).not.toThrow();
  });

  it('fails a keyed collection that predates membership, naming both steps', () => {
    expect(() =>
      assertBookkeepingPresent(keyedTypeWith(), fields('title'), 'objects'),
    ).toThrow(/drop “objects”.*rotate the pipeline version/s);
  });
});

describe('openDocuments', () => {
  const dataset = new Dataset({
    iri: new URL('http://example.org/dataset/a'),
    distributions: [],
  });

  /** A client answering searches from a fixed page, recording what it is told. */
  const clientAnswering = (
    hits: readonly Record<string, unknown>[],
    multiSearchResult: Record<string, unknown> = { hits: [] },
  ) => {
    const imported: unknown[][] = [];
    const client = {
      collections: () => ({
        documents: () => ({
          search: async () => ({
            hits: hits.map((document) => ({ document })),
          }),
          import: async (batch: unknown[]) => {
            imported.push(batch);
            return batch.map(() => ({ success: true }));
          },
          delete: async () => ({ num_deleted: 0 }),
        }),
      }),
      multiSearch: { perform: async () => ({ results: [multiSearchResult] }) },
    };
    return { client: client as unknown as Client, imported };
  };

  const keyed = { ...keyedTypeWith(), name: 'Place' } as SearchType;
  const options = {
    searchType: keyed,
    runId: 'run-1',
    startedAt: '2026-07-06T12:00:00.000Z',
    batchSize: 1000,
  };

  it('refuses to spin when a selected document carries none of the datasets', async () => {
    // The filter and the stored membership disagreeing would otherwise loop
    // forever: the document is rewritten unchanged and selected again.
    const { client } = clientAnswering([
      {
        id: 'x',
        referenced_by: [{ dataset: 'http://example.org/other', run: 1 }],
      },
    ]);

    await expect(
      openDocuments(client, 'places', options).dropAll(dataset),
    ).rejects.toThrow(
      /carrying none of them, so the sweep cannot make progress/,
    );
  });

  it('raises a membership read that failed inside a multi_search', async () => {
    // multi_search reports a failed entry inline instead of rejecting; taking
    // it for “no membership stored” would erase every referrer it covered.
    const { client } = clientAnswering([], { error: 'shard down' });

    const documents = openDocuments<{ id: string }>(client, 'places', options);
    await documents.add(dataset, stream([{ id: 'x' }]));
    await expect(documents.flush()).rejects.toThrow(
      /Reading membership from “places” failed: shard down/,
    );
  });

  it('adds this dataset to the membership already stored, replacing its own entry', async () => {
    const { client, imported } = clientAnswering([], {
      hits: [
        {
          document: {
            id: 'x',
            referenced_by: [
              { dataset: 'http://example.org/dataset/b', run: 1 },
              { dataset: dataset.iri.toString(), run: 1 },
            ],
          },
        },
      ],
    });

    const documents = openDocuments<{ id: string }>(client, 'places', options);
    await documents.add(dataset, stream([{ id: 'x' }]));
    await documents.flush();

    expect(imported).toEqual([
      [
        {
          id: 'x',
          referenced_by: [
            { dataset: 'http://example.org/dataset/b', run: 1 },
            {
              dataset: dataset.iri.toString(),
              run: Date.parse(options.startedAt),
            },
          ],
        },
      ],
    ]);
  });

  it('starts the membership from scratch for a document that carries none', async () => {
    const { client, imported } = clientAnswering([], {
      hits: [{ document: { id: 'x' } }],
    });

    const documents = openDocuments<{ id: string }>(client, 'places', options);
    await documents.add(dataset, stream([{ id: 'x' }]));
    await documents.flush();

    expect(imported).toEqual([
      [
        {
          id: 'x',
          referenced_by: [
            {
              dataset: dataset.iri.toString(),
              run: Date.parse(options.startedAt),
            },
          ],
        },
      ],
    ]);
  });

  it('reads a batch too wide for one multi_search as several requests', async () => {
    // `batchSize` is the caller's knob; it must not decide whether a write
    // succeeds. Typesense accepts 50 searches per request by default, and a
    // batch of 10 001 ids needs 51 lookups.
    const requests: number[] = [];
    const client = {
      collections: () => ({
        documents: () => ({
          import: async (batch: unknown[]) =>
            batch.map(() => ({ success: true })),
        }),
      }),
      multiSearch: {
        perform: async ({ searches }: { searches: unknown[] }) => {
          requests.push(searches.length);
          return { results: searches.map(() => ({ hits: [] })) };
        },
      },
    } as unknown as Client;

    const documents = openDocuments<{ id: string }>(client, 'places', {
      ...options,
      batchSize: 20_000,
    });
    await documents.add(
      dataset,
      stream(
        Array.from({ length: 10_001 }, (unused, index) => ({
          id: `http://example.org/place/${index}`,
        })),
      ),
    );
    await documents.flush();

    expect(requests).toEqual([50, 1]);
  });

  /** A client whose imports refuse the documents `refuse` names, with its
   *  error, and whose updates refuse everything. */
  const clientRefusing = (refuse: (document: { id: string }) => boolean) =>
    ({
      collections: () => ({
        documents: () => ({
          import: async (
            batch: { id: string }[],
            { action }: { action: string },
          ) =>
            batch.map((document) =>
              action === 'update' || refuse(document)
                ? { success: false, error: `bad ${document.id}`, code: 400 }
                : { success: true },
            ),
          // One document both datasets reference, so retracting one rewrites
          // the other’s membership with an update.
          search: async () => ({
            hits: [
              {
                document: {
                  id: 'shared',
                  referenced_by: [
                    { dataset: 'http://example.org/dataset/a', run: 1 },
                    { dataset: 'http://example.org/dataset/b', run: 1 },
                  ],
                },
              },
            ],
          }),
        }),
      }),
      multiSearch: { perform: async () => ({ results: [{ hits: [] }] }) },
    }) as unknown as Client;

  const other = new Dataset({
    iri: new URL('http://example.org/dataset/b'),
    distributions: [],
  });

  it('leaves out the documents an import refused, counting them against their dataset', async () => {
    const documents = openDocuments<{ id: string }>(
      clientRefusing((document) => document.id !== 'x'),
      'places',
      options,
    );
    await documents.add(dataset, stream([{ id: 'x' }, { id: 'y' }]));
    // The refused document lands with the other dataset’s batch, yet counts
    // as the dataset’s own.
    await documents.add(other, stream([{ id: 'z' }]));

    expect(await documents.settle(dataset)).toEqual({
      written: 2,
      rejected: 1,
      reasons: [{ reason: 'bad y', count: 1, examples: ['y'] }],
    });
    expect(await documents.settle(other)).toEqual({
      written: 1,
      rejected: 1,
      reasons: [{ reason: 'bad z', count: 1, examples: ['z'] }],
    });
    // Settling starts the count afresh.
    expect(await documents.settle(dataset)).toEqual({
      written: 0,
      rejected: 0,
      reasons: [],
    });
  });

  it('attributes the documents of an owned collection to their dataset too', async () => {
    const owned = { ...typeWith(), name: 'Work' } as SearchType;
    const documents = openDocuments<{ id: string }>(
      clientRefusing((document) => document.id === 'y'),
      'works',
      { ...options, searchType: owned },
    );
    await documents.add(dataset, stream([{ id: 'x' }]));
    await documents.add(other, stream([{ id: 'y' }]));

    expect((await documents.settle(dataset)).rejected).toBe(0);
    expect((await documents.settle(other)).rejected).toBe(1);
  });

  it('leaves out a document missing a required field before Typesense sees it', async () => {
    const work = {
      name: 'Work',
      class: 'https://example.org/Work',
      fields: [
        {
          name: 'name',
          kind: 'text',
          path: 'https://schema.org/name',
          locales: ['nl'],
          output: true,
          required: true,
        },
      ],
    } as SearchType;
    const { client, imported } = clientAnswering([]);
    const documents = openDocuments<{ id: string }>(client, 'works', {
      ...options,
      searchType: work,
    });
    await documents.add(
      dataset,
      stream([{ id: 'note' }, { id: 'work', name_nl: 'Titel' }]),
    );

    expect(await documents.settle(dataset)).toEqual({
      written: 2,
      rejected: 1,
      reasons: [
        {
          reason: 'missing required field “name”',
          count: 1,
          examples: ['note'],
        },
      ],
    });
    expect(imported.flat()).toEqual([expect.objectContaining({ id: 'work' })]);
  });

  it('merges two datasets’ writes of one keyed document, leaving out one missing a field', async () => {
    const { client, imported } = clientAnswering([]);
    const documents = openDocuments<{ id: string }>(client, 'places', {
      ...options,
      searchType: {
        ...keyed,
        fields: [
          ...keyed.fields,
          { name: 'title', kind: 'keyword', output: true, required: true },
        ],
      } as SearchType,
    });
    await documents.add(
      dataset,
      stream([{ id: 'place', title: 'Maastricht' }, { id: 'untitled' }]),
    );
    await documents.add(other, stream([{ id: 'place', title: 'Maastricht' }]));
    await documents.flush();

    expect(imported).toEqual([
      [
        expect.objectContaining({
          id: 'place',
          referenced_by: [
            { dataset: dataset.iri.toString(), run: expect.any(Number) },
            { dataset: other.iri.toString(), run: expect.any(Number) },
          ],
        }),
      ],
    ]);
    expect((await documents.settle(dataset)).rejected).toBe(1);
  });

  it('names every required field a refused document lacks', async () => {
    const work = {
      name: 'Work',
      class: 'https://example.org/Work',
      fields: [
        { name: 'title', kind: 'keyword', output: true, required: true },
        { name: 'year', kind: 'integer', output: true, required: true },
      ],
    } as SearchType;
    const documents = openDocuments<{ id: string }>(
      clientAnswering([]).client,
      'works',
      { ...options, searchType: work },
    );
    await documents.add(dataset, stream([{ id: 'note' }]));

    expect((await documents.settle(dataset)).reasons[0].reason).toBe(
      'missing required fields “title”, “year”',
    );
  });

  it('keeps a bounded tally however many distinct reasons there are', async () => {
    const documents = openDocuments<{ id: string }>(
      clientRefusing(() => true),
      'places',
      options,
    );
    await documents.add(
      dataset,
      stream(Array.from({ length: 30 }, (_, index) => ({ id: `d${index}` }))),
    );

    const { rejected, reasons } = await documents.settle(dataset);
    expect(rejected).toBe(30);
    expect(reasons).toHaveLength(11);
    expect(reasons[0]).toEqual({
      reason: 'other reasons',
      count: 20,
      examples: ['d10', 'd11', 'd12'],
    });
  });

  it('throws on a failure that is not the document’s fault, counting nothing', async () => {
    const client = {
      collections: () => ({
        documents: () => ({
          import: async (batch: unknown[]) =>
            batch.map(() => ({
              success: false,
              error: 'Rejecting write: running out of resource type',
              code: 507,
            })),
        }),
      }),
    } as unknown as Client;
    const documents = openDocuments<{ id: string }>(client, 'works', {
      ...options,
      searchType: { ...typeWith(), name: 'Work' } as SearchType,
    });
    await documents.add(dataset, stream([{ id: 'x' }]));

    await expect(documents.settle(dataset)).rejects.toThrow(
      'Typesense upsert into “works” failed: Rejecting write: running out of resource type (HTTP 507)',
    );
  });

  it('counts a refusal once per write merged into the document', async () => {
    const documents = openDocuments<{ id: string }>(
      clientRefusing(() => true),
      'places',
      options,
    );
    await documents.add(dataset, stream([{ id: 'p' }, { id: 'p' }]));

    const { written, rejected } = await documents.settle(dataset);
    expect({ written, rejected }).toEqual({ written: 2, rejected: 2 });
  });

  it('still throws when an update of the bookkeeping is refused', async () => {
    const documents = openDocuments<{ id: string }>(
      clientRefusing(() => false),
      'places',
      options,
    );

    await expect(documents.dropAll(other)).rejects.toThrow(
      /update into “places” failed for 1\/1 documents/,
    );
  });
});
