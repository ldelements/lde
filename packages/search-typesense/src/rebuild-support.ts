import type { Client } from 'typesense';
import type { SearchType } from '@lde/search';
import type { CollectionDefinitionOptions } from './collection-definition.js';
import { DEFAULT_LOCK_TTL_MS } from './lock.js';
import { DEFAULT_BATCH_SIZE } from './import.js';

/**
 * The tuning knobs both rebuild writers share, on top of the collection-definition
 * options. Each writer may add its own (In-place adds `maxSweepableSources`).
 */
export interface RebuildOptions extends CollectionDefinitionOptions {
  /** Documents imported per Typesense request (default 1000). */
  readonly batchSize?: number;
  /** A held lock older than this (ms) is reclaimed (default 10 minutes). */
  readonly lockTtlMs?: number;
}

/** The shared options resolved to concrete values plus the residual
 *  collection-definition options a writer passes to {@link buildCollectionDefinition}. */
export interface ResolvedRebuildOptions {
  readonly name: string;
  readonly batchSize: number;
  readonly lockTtlMs: number;
  readonly definitionOptions: CollectionDefinitionOptions;
}

/** Apply the shared defaults, once, so neither writer restates them. */
export function resolveRebuildOptions(
  options: RebuildOptions,
): ResolvedRebuildOptions {
  const {
    batchSize = DEFAULT_BATCH_SIZE,
    lockTtlMs = DEFAULT_LOCK_TTL_MS,
    ...definitionOptions
  } = options;
  return {
    name: definitionOptions.name,
    batchSize,
    lockTtlMs,
    definitionOptions,
  };
}

/**
 * Reject a {@link SearchType} that declares any of the bookkeeping field names
 * a writer stamps, so a domain field can never collide with `source` /
 * `last_seen`.
 */
export function assertNoReservedFields(
  searchType: SearchType,
  reserved: readonly string[],
): void {
  const clashing = searchType.fields.filter((field) =>
    reserved.includes(field.name),
  );
  if (clashing.length > 0) {
    throw new Error(
      `SearchType “${searchType.name}” declares reserved bookkeeping field(s) ${clashing
        .map((field) => `“${field.name}”`)
        .join(', ')}`,
    );
  }
}

/** Stamp each document with fixed bookkeeping fields as it streams past. */
export async function* stampDocuments<TDocument>(
  documents: AsyncIterable<TDocument>,
  stamp: Readonly<Record<string, string>>,
): AsyncIterable<TDocument & Record<string, string>> {
  for await (const document of documents) {
    yield { ...document, ...stamp };
  }
}

/** Delete a collection’s documents matching a Typesense filter. */
export async function deleteByFilter(
  client: Client,
  collection: string,
  filterBy: string,
): Promise<void> {
  await client
    .collections(collection)
    .documents()
    .delete({ filter_by: filterBy });
}
