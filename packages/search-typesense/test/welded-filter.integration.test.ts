import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Client } from 'typesense';
import { TypesenseContainer } from './typesense-container.js';

/**
 * The engine guarantee the welded co-element filter rests on, pinned against a
 * real Typesense rather than reasoned about – *this agent in this role*, the
 * one question a qualified edge buys over two flat fields.
 *
 * **Why an integration test and not a compiler assertion.** The filter this
 * compiles to is valid, documented syntax, and the compiler emitted it
 * correctly all along. What no unit test could see is that the engine’s answer
 * depends on the *shape of the stored values*: on `typesense/typesense:30.2` a
 * weld over entries whose leaves hold arrays never returns at all – no error,
 * no timeout, no response – while every unwelded variant answers in
 * milliseconds. Only a live engine says so, which is why the entries below are
 * written in both shapes and both are asserted.
 *
 * The trap, asserted here because it is silent in the other direction:
 * `role:=X && agent:=Y` written OUTSIDE the braces matches a work where X and Y
 * occur in *different* entries. That false positive is the whole reason the
 * weld exists, so a weld that merely returns is not enough – it has to return
 * strictly less.
 *
 * See [ADR 26](../../../docs/decisions/0026-fan-out-a-qualified-edge-into-one-entry-per-tuple.md)
 * and [#798](https://github.com/ldelements/lde/issues/798).
 */
describe('a welded co-element filter', () => {
  const container = new TypesenseContainer();
  let client: Client;

  const collection = 'works';
  const etser = 'http://vocab.example/role/etser';
  const drukker = 'http://vocab.example/role/drukker';
  const rembrandt = 'http://data.example/agent/rembrandt';
  const other = 'http://data.example/agent/other';

  /** The filter a compiled {@link WeldedCriterion} produces. */
  const welded = (role: string, agent: string) =>
    `credit.{role:=\`${role}\` && agent_id:=\`${agent}\`}`;

  const found = async (filterBy: string) => {
    const result = await client
      .collections(collection)
      .documents()
      .search({ q: '*', query_by: '', filter_by: filterBy }, {});
    return (result.hits ?? [])
      .map((hit) => (hit.document as { id: string }).id)
      .sort();
  };

  beforeAll(async () => {
    client = await container.start();
    await client.collections().create({
      name: collection,
      enable_nested_fields: true,
      fields: [
        { name: 'credit', type: 'object[]' },
        { name: 'credit.role', type: 'string[]' },
        { name: 'credit.agent_id', type: 'string[]' },
      ],
    });
    await client
      .collections(collection)
      .documents()
      .import(
        [
          // Fanned out: one entry per (role, agent) tuple, every leaf a single
          // value – what the projection now writes.
          {
            id: 'fanned-match',
            credit: [{ role: etser, agent_id: rembrandt }],
          },
          // The false positive the weld exists to exclude: both values are
          // present in the document, in different entries.
          {
            id: 'fanned-cross',
            credit: [
              { role: etser, agent_id: other },
              { role: drukker, agent_id: rembrandt },
            ],
          },
        ],
        { action: 'create' },
      );
  }, 120_000);

  afterAll(async () => {
    await container.stop();
  });

  it('matches only the work whose ONE entry satisfies both conditions', async () => {
    expect(await found(welded(etser, rembrandt))).toEqual(['fanned-match']);
  });

  it('returns strictly less than the same conditions unwelded', async () => {
    // Unwelded, the cross-matched work comes back too – Rembrandt is on it, and
    // so is the etser role, just never together. This is the assertion that
    // makes the weld worth its cost.
    expect(
      await found(
        `credit.role:=\`${etser}\` && credit.agent_id:=\`${rembrandt}\``,
      ),
    ).toEqual(['fanned-cross', 'fanned-match']);
  });

  it('answers a weld naming no matching tuple', async () => {
    expect(await found(welded(drukker, other))).toEqual([]);
  });

  it('hangs on 30.2 where an entry holds arrays, which is why we fan out', async () => {
    // The defect this shape exists to avoid, pinned so a future engine bump
    // tells us when it is gone. Typesense answers every OTHER form of this
    // query in milliseconds; welded over array-valued leaves it never responds,
    // so the client's own 5 s timeout is what ends the call.
    await client
      .collections(collection)
      .documents()
      .import(
        [{ id: 'arrayed', credit: [{ role: [etser], agent_id: [rembrandt] }] }],
        { action: 'create' },
      );

    // Either condition alone still answers instantly over the same document.
    expect(await found(`credit.role:=\`${etser}\``)).toContain('arrayed');

    await expect(found(welded(etser, rembrandt))).rejects.toThrow();
  }, 60_000);
});
