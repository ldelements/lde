import type { Client } from 'typesense';
import type { SearchSchema, SearchType } from '@lde/search';
import {
  datasetField,
  isInternalField,
  joinGraph,
  physicalFields,
  referenceFields,
} from '@lde/search/adapter';
import {
  buildCollectionDefinition,
  type CollectionDefinitionOptions,
} from './collection-definition.js';
import { deriveCollectionName } from './collection-name.js';
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

/**
 * Reject a declared dataset field the provenance bookkeeping cannot be kept on.
 * A type declaring one makes it the collection’s provenance field – the column
 * the membership sweep enumerates and deletes by – so the declaration has to answer
 * *which single dataset is this document’s* the way the private `source` field
 * did:
 *
 * - **not `array`**: Typesense reads `field:=[a,b]` over a `string[]` as
 *   *contains any*, so a departed source would take every document that merely
 *   mentions it – including entities another selected dataset still
 *   contributes;
 * - **no `transform`**: the sweep compares the stored value against the run’s
 *   selection, which carries raw dataset IRIs, so a transformed value would
 *   match nothing and the sweep would silently stop deleting;
 * - **`facetable`** where the writer enumerates the indexed sources by faceting
 *   it (the In-place writer does; Blue/green only ever filters by a known IRI)
 *   – and faceted **on its own name**: a reference inheriting a facet policy
 *   from the type it names facets a companion holding only the admitted keys
 *   (`physicalFields(field, schema).facet`), so enumerating the sources
 *   through it would miss every dataset the policy excludes. `schema` is what
 *   resolves that; without one no policy is visible, as nowhere else.
 *
 * Thrown at writer construction, so a declaration that cannot be swept fails
 * before a run touches the index rather than at the sweep, after the writes.
 */
export function assertSweepableProvenanceField(
  searchType: SearchType,
  options: {
    readonly requireFacetable: boolean;
    readonly schema?: SearchSchema;
  },
): void {
  const field = datasetField(searchType);
  if (field === undefined || isInternalField(field)) {
    return;
  }
  const problems: string[] = [];
  if (field.array === true) {
    problems.push(
      'it is an array, and a membership sweep over one would delete every document merely mentioning a departed dataset',
    );
  }
  if (field.transform !== undefined) {
    problems.push(
      'it declares a transform, and the sweep matches the stored value against the run’s raw dataset IRIs',
    );
  }
  if (options.requireFacetable && field.facetable !== true) {
    problems.push(
      'it is not facetable, and the membership sweep enumerates the indexed datasets by faceting it',
    );
  } else if (
    options.requireFacetable &&
    physicalFields(field, options.schema).facet !== field.name
  ) {
    problems.push(
      'it inherits a facet policy from the type it names, so the engine facets only the datasets the policy admits, and the membership sweep enumerates the indexed datasets by faceting it',
    );
  }
  if (problems.length > 0) {
    throw new Error(
      `SearchType “${searchType.name}” declares “${field.name}” over the indexed dataset, which this writer keeps its provenance bookkeeping on, but ${problems.join('; and ')}.`,
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
