import type { SearchType } from '@lde/search';
import { joinGraph, referenceFields } from '@lde/search/adapter';
import {
  buildCollectionDefinition,
  type CollectionDefinitionOptions,
} from './collection-definition.js';
import { deriveCollectionName } from './collection-name.js';
import { DEFAULT_LOCK_TTL_MS } from './lock.js';

/** Documents imported per Typesense request unless a writer is told otherwise. */
const DEFAULT_BATCH_SIZE = 1000;

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
  readonly batchSize: number;
  readonly lockTtlMs: number;
  /** The collection-definition options with `collectionNameFor` resolved to a
   *  total function – the one place the naming convention lives, so the
   *  collection a writer talks to, the definition it creates and the peer
   *  collections its references name cannot say different things. */
  readonly definitionOptions: CollectionDefinitionOptions & {
    readonly collectionNameFor: (searchType: SearchType) => string;
  };
}

/**
 * Apply the shared defaults, once, so neither writer restates them – including
 * the collection naming, derived from each type ({@link deriveCollectionName})
 * when the deployment supplies none.
 *
 * Writers resolve at construction rather than per run, so an underivable name
 * throws when the writer is built, not on the first rebuild. The collection
 * definition is built here and discarded for the same reason: every way a
 * declaration can fail to describe a collection – an unresolvable surfaced
 * inline reference, whose nesting needs the schema, or a joinable reference
 * whose target it resolves the same way – then fails at construction rather
 * than inside the first run, after a lock is held and a whole extraction has
 * been paid for.
 */
export function resolveRebuildOptions(
  searchType: SearchType,
  options: RebuildOptions,
): ResolvedRebuildOptions {
  const {
    batchSize = DEFAULT_BATCH_SIZE,
    lockTtlMs = DEFAULT_LOCK_TTL_MS,
    ...definitionOptions
  } = options;
  const resolved = {
    batchSize,
    lockTtlMs,
    definitionOptions: {
      ...definitionOptions,
      collectionNameFor:
        definitionOptions.collectionNameFor ?? deriveCollectionName,
    },
  };
  assertDistinctJoinTargetNames(searchType, resolved.definitionOptions);
  buildCollectionDefinition(searchType, resolved.definitionOptions);
  return resolved;
}

/**
 * Reject a `collectionNameFor` that gives a join target the same name as the
 * type doing the joining.
 *
 * The trap is the obvious migration from the `name` option this replaced:
 * `name: 'staging_works'` reads as `collectionNameFor: () => 'staging_works'`,
 * a constant function – which now also names every peer, so the emitted
 * reference points the collection at ITSELF. Nothing downstream complains:
 * Typesense accepts the self-reference and every join through it then answers
 * nothing.
 *
 * Only the (type, target) pairs this type actually joins to are checked, so a
 * deployment deliberately sharing one collection between unrelated types – the
 * several-label-sources-in-one-`labels` case – stays allowed.
 */
function assertDistinctJoinTargetNames(
  searchType: SearchType,
  options: CollectionDefinitionOptions & {
    readonly collectionNameFor: (searchType: SearchType) => string;
  },
): void {
  const { schema, collectionNameFor } = options;
  if (schema === undefined) {
    return;
  }
  const own = collectionNameFor(searchType);
  for (const field of referenceFields(searchType)) {
    const target = joinGraph(schema).resolve(searchType, [field.name]);
    if (target !== undefined && collectionNameFor(target) === own) {
      throw new Error(
        `The collection naming for “${searchType.name}” gives its join target “${target.name}” the same collection “${own}”, so the reference on “${field.name}” would point the collection at itself and every join through it would answer nothing. A constant “collectionNameFor” does this – derive the name from the type it is given (e.g. \`(type) => \`prefix_\${deriveCollectionName(type)}\`\`).`,
      );
    }
  }
}
