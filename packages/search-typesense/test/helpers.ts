import type { Client } from 'typesense';
import type { RunContext } from '@lde/pipeline';

/** The lock collection the rebuild writers coordinate through. */
export const LOCK_COLLECTION = 'rebuild_locks';

let runSequence = 0;

/**
 * A fresh {@link RunContext} per call: run ids are unique and `startedAt`
 * strictly increases across runs, as the Pipeline guarantees.
 */
export function makeRunContext(
  selectedSources: readonly string[] = [],
): RunContext {
  runSequence += 1;
  return {
    runId: `run-${runSequence}`,
    startedAt: new Date(
      Date.parse('2026-07-06T12:00:00.000Z') + runSequence * 1000,
    ).toISOString(),
    selectedSources: () => selectedSources,
  };
}

/** The run id of the most recently created {@link makeRunContext}. */
export function currentRunId(): string {
  return `run-${runSequence}`;
}

/** Yield the given documents as an async iterable, like a streaming source. */
export async function* stream<Document>(
  documents: readonly Document[],
): AsyncIterable<Document> {
  yield* documents;
}

/** An HTTP error the way the Typesense client raises one. */
export function typesenseError(status: number): Error & { httpStatus: number } {
  return Object.assign(new Error(`HTTP ${status}`), { httpStatus: status });
}

/**
 * Seed a held rebuild lock, as another pod’s in-flight run would have left it
 * – with a custom `acquired_at` so staleness scenarios are constructible.
 */
export async function seedLock(
  client: Client,
  name: string,
  acquiredAt: number,
): Promise<void> {
  await client.collections().create({
    name: LOCK_COLLECTION,
    fields: [{ name: 'acquired_at', type: 'int64' }],
  });
  await client
    .collections(LOCK_COLLECTION)
    .documents()
    .create({ id: name, acquired_at: acquiredAt });
}
