import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Client } from 'typesense';
import { TypesenseContainer } from './typesense-container.js';

/**
 * The engine guarantees membership rests on, pinned against a real Typesense
 * rather than reasoned about: they are not ours to fix, and the design of
 * `openDocuments` is unbuildable without them.
 *
 * A keyed collection records **which datasets reference a document** as one
 * nested array – `referenced_by: [{ dataset, run }]` – and every sweep is a
 * filter over it. That works only because a filter written as
 * `referenced_by.{…}` applies its conditions **within a single element**, so
 * one dataset’s run can never answer for another’s.
 *
 * The trap, asserted below because it is silent: **negation does not
 * correlate**. `referenced_by.{dataset:=A && run:!=R}` reads as *has an element
 * for A, and has no element anywhere carrying R* – which is why `run` is an
 * ordered stamp (`Date.parse(startedAt)`) compared with `<`, and never a run id
 * compared with `!=`. It returns no error, just nothing, and a sweep that
 * deletes nothing is a sweep nobody notices.
 *
 * Every assertion is repeated through `documents/delete`, because the sweep
 * deletes by filter and the delete endpoint is not obliged to parse filters the
 * way search does.
 */
describe('membership filters', () => {
  const container = new TypesenseContainer();
  let client: Client;

  const collection = 'terms';
  const datasetA = 'http://example.org/dataset/a';
  const datasetB = 'http://example.org/dataset/b';
  const datasetC = 'http://example.org/dataset/c';
  /** This run’s stamp; 90 stands for any earlier run. */
  const thisRun = 100;

  beforeAll(async () => {
    client = await container.start();
  }, 120_000);

  afterAll(async () => {
    await container.stop();
  });

  beforeEach(async () => {
    await client
      .collections(collection)
      .delete()
      .catch(() => undefined);
    await client.collections().create({
      name: collection,
      enable_nested_fields: true,
      fields: [
        { name: 'title', type: 'string' },
        { name: 'referenced_by', type: 'object[]' },
        { name: 'referenced_by.dataset', type: 'string[]', facet: true },
        { name: 'referenced_by.run', type: 'int64[]' },
      ],
    });
    await client
      .collections(collection)
      .documents()
      .import(
        [
          {
            // A wrote it this run; B referenced it in an earlier one.
            id: 'fresh-for-a',
            title: 'Maastricht',
            referenced_by: [
              { dataset: datasetA, run: thisRun },
              { dataset: datasetB, run: 90 },
            ],
          },
          {
            // A did NOT write it this run; B did. The correlation case: an
            // uncorrelated filter sees `run` containing 100 through B’s element
            // and wrongly spares this document from A’s stale sweep.
            id: 'stale-for-a',
            title: 'Heerlen',
            referenced_by: [
              { dataset: datasetA, run: 90 },
              { dataset: datasetB, run: thisRun },
            ],
          },
          {
            id: 'b-only',
            title: 'Sittard',
            referenced_by: [{ dataset: datasetB, run: thisRun }],
          },
        ],
        { action: 'upsert' },
      );
  });

  async function idsMatching(filterBy: string): Promise<string[]> {
    const response = await client.collections(collection).documents().search({
      q: '*',
      query_by: 'title',
      per_page: 250,
      filter_by: filterBy,
    });
    return (response.hits ?? [])
      .map((hit) => (hit.document as { id: string }).id)
      .sort();
  }

  const stale = `referenced_by.{dataset:=\`${datasetA}\` && run:<${thisRun}}`;

  it('correlates an ordered comparison within one element', async () => {
    expect(await idsMatching(stale)).toEqual(['stale-for-a']);
  });

  it('correlates equality within one element – the documents this run wrote', async () => {
    expect(
      await idsMatching(
        `referenced_by.{dataset:=\`${datasetA}\` && run:=${thisRun}}`,
      ),
    ).toEqual(['fresh-for-a']);
  });

  it('does NOT correlate a negation – the trap the ordered stamp avoids', async () => {
    // Reads as “references A, and carries 100 nowhere”, so every document A
    // references is excluded by B’s element. Silent, and empty.
    expect(
      await idsMatching(
        `referenced_by.{dataset:=\`${datasetA}\` && run:!=${thisRun}}`,
      ),
    ).toEqual([]);
  });

  it('selects every document a dataset references, several datasets at a time', async () => {
    expect(
      await idsMatching(
        `referenced_by.dataset:=[\`${datasetA}\`,\`${datasetC}\`]`,
      ),
    ).toEqual(['fresh-for-a', 'stale-for-a']);
  });

  it('facets one bucket per referring dataset', async () => {
    const response = await client.collections(collection).documents().search({
      q: '*',
      query_by: 'title',
      per_page: 0,
      facet_by: 'referenced_by.dataset',
      max_facet_values: 10,
    });
    const counts = (response.facet_counts?.[0]?.counts ?? []).map((count) => [
      count.value,
      count.count,
    ]);
    expect(counts.sort()).toEqual([
      [datasetA, 2],
      [datasetB, 3],
    ]);
  });

  it('accepts the correlated filter in a delete', async () => {
    expect(
      await client.collections(collection).documents().delete({
        filter_by: stale,
      }),
    ).toMatchObject({ num_deleted: 1 });
    expect(await idsMatching('id:!=nothing')).toEqual([
      'b-only',
      'fresh-for-a',
    ]);
  });
});
