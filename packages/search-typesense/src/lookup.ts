import type { Client } from 'typesense';
import {
  type ReferenceProjection,
  type RootType,
  type SearchSchema,
  type SearchType,
} from '@lde/search';
import {
  displayFieldName,
  fieldNamed,
  labelFieldOf,
  nestedReferenceType,
  rootTypeNamed,
} from '@lde/search/adapter';
import { escapeFilterValue } from './query-compiler.js';

/**
 * One resolved level of a {@link ReferenceProjection}. A level is one of two
 * things, discriminated by `via`, because the two cost different things:
 *
 * - **`lookup`** – referents fetched from the target’s own collection, keyed by
 *   id and still in the engine’s flat physical shape. One batched round trip.
 * - **`nested`** – an inline reference descended into. Its entries are already
 *   in the hit, so nothing is fetched and there is no target; the level exists
 *   only to carry the levels resolved *below* it.
 *
 * Kept flat rather than reconstructed here so one reconstruction path serves
 * hits and referents alike – the surface never learns that a nested document
 * arrived by a second round-trip rather than from the hit itself.
 */
export type ResolvedReferents =
  | {
      readonly via: 'lookup';
      /** The Root Type these referents are declared by – reconstruction reads
       *  them through the target’s own declaration, never the referrer’s. */
      readonly target: RootType;
      readonly documents: ReadonlyMap<string, Record<string, unknown>>;
      /** Keyed by the reference field’s name on the type this level carries. */
      readonly children: ReadonlyMap<string, ResolvedReferents>;
    }
  | {
      readonly via: 'nested';
      readonly children: ReadonlyMap<string, ResolvedReferents>;
    };

/** Typesense caps a filter list; the same batch size the label lookup uses. */
const BATCH_SIZE = 200;

/**
 * Resolve a projection against the documents that name its referents: one
 * batched `multi_search` **per level**, never per document, because the IRIs of
 * a level are deduped across the whole page before the round-trip and grouped
 * by the collection they live in.
 *
 * Failure degrades rather than throws: an unresolved level leaves its
 * references as bare ids, exactly as an unresolved label does.
 */
export async function resolveProjection(
  client: Pick<Client, 'multiSearch'>,
  projection: ReferenceProjection | undefined,
  searchType: SearchType,
  schema: SearchSchema,
  collections: ReadonlyMap<string, string>,
  parents: readonly Record<string, unknown>[],
  onError?: (error: unknown) => void,
): Promise<ReadonlyMap<string, ResolvedReferents>> {
  const resolved = new Map<string, ResolvedReferents>();
  if (projection === undefined || parents.length === 0) {
    return resolved;
  }
  // The level's fields resolve CONCURRENTLY: they read from different
  // collections and nothing links them, so running them in turn would make the
  // stated bound – one round-trip per level – one per field instead.
  const levels = await Promise.all(
    Object.entries(projection).map(async ([name, level]) => {
      const field = fieldNamed(searchType, name);
      if (field === undefined) {
        return undefined;
      }
      // An inline level costs no round trip: its entries are already in the
      // parents. Flatten them out and hand them down, so the level BELOW reads
      // its ids off the entries rather than off the document – which is the
      // whole of what makes a lookup inside a qualified edge resolvable.
      const nested = nestedReferenceType(schema, field);
      if (nested !== undefined) {
        return [
          name,
          {
            via: 'nested',
            children: await resolveProjection(
              client,
              level.resolve,
              nested,
              schema,
              collections,
              entriesOf(parents, name),
              onError,
            ),
          },
        ] as const;
      }
      if (field.kind !== 'reference' || field.ref?.strategy !== 'lookup') {
        // `assertValidQuery` rejects this for every caller; skipping keeps a
        // hand-built query from throwing here rather than at the port’s guard.
        return undefined;
      }
      const target = rootTypeNamed(schema, field.ref.target);
      const collection =
        target === undefined ? undefined : collections.get(target.class);
      if (target === undefined || collection === undefined) {
        return undefined;
      }
      const include = includeFields(target, level.fields, level.resolve);
      const iris = distinctIris(parents, name);
      // Nothing to read: no referent named, or the selection reduced to the
      // `id` the referring document already carries.
      if (iris.length === 0 || include.length <= 1) {
        return undefined;
      }
      const documents = await fetchReferents(
        client,
        collection,
        iris,
        include,
        onError,
      );
      return [
        name,
        {
          via: 'lookup',
          target,
          documents,
          // The level below reads the IRIs off the documents this one just
          // fetched – one more round-trip for the page, whatever its size.
          children: await resolveProjection(
            client,
            level.resolve,
            target,
            schema,
            collections,
            [...documents.values()],
            onError,
          ),
        },
      ] as const;
    }),
  );
  for (const level of levels) {
    if (level !== undefined) {
      resolved.set(level[0], level[1]);
    }
  }
  return resolved;
}

/**
 * The nested entries a page of documents carries under one inline reference,
 * flattened into one list – the “documents” the level below resolves against.
 *
 * Flattening rather than grouping is what keeps the round-trip count per
 * *level* rather than per document: every entry on the page contributes its ids
 * to one batch, and reconstruction re-associates them afterwards by id.
 */
function entriesOf(
  documents: readonly Record<string, unknown>[],
  field: string,
): Record<string, unknown>[] {
  return documents.flatMap((document) => {
    const raw = document[field];
    return (Array.isArray(raw) ? raw : [raw]).filter(
      (entry): entry is Record<string, unknown> =>
        typeof entry === 'object' && entry !== null,
    );
  });
}

/**
 * Every distinct id a page of documents carries under one reference field.
 *
 * A reference stores its ids one of two ways, and which one is about how much
 * of the referent the deployment wants stored, not about identity: a plain
 * reference stores the id itself, while a
 * {@link ReferenceStrategy.local local} lookup stores the endpoint’s own
 * document, whose `id` is the same value. Both are read, so a level resolves
 * the same either way.
 */
function distinctIris(
  documents: readonly Record<string, unknown>[],
  field: string,
): readonly string[] {
  const iris = new Set<string>();
  for (const document of documents) {
    const raw = document[field];
    for (const value of Array.isArray(raw) ? raw : [raw]) {
      const id =
        typeof value === 'object' && value !== null
          ? (value as Record<string, unknown>).id
          : value;
      if (typeof id === 'string' && id !== '') {
        iris.add(id);
      }
    }
  }
  return [...iris];
}

/**
 * The physical fields a level needs: the target’s `id`, the physical fanout of
 * each logical field it asked for, and the reference fields the level below
 * reads its IRIs from. Asking for a field set rather than the whole document is
 * what keeps a lookup’s cost proportional to the query rather than to how wide
 * the target happens to be.
 *
 * With no `fields`, a level carries the target’s label alone – what every
 * reference carried before a projection could ask for more.
 */
function includeFields(
  target: RootType,
  wanted: readonly string[] | undefined,
  below: ReferenceProjection | undefined,
): readonly string[] {
  const labelField = labelFieldOf(target);
  const names = wanted ?? (labelField === undefined ? [] : [labelField.name]);
  const physical = new Set<string>(['id']);
  for (const name of names) {
    const field = fieldNamed(target, name);
    if (field === undefined || field.output !== true) {
      continue;
    }
    if (field.kind === 'text') {
      for (const locale of field.locales) {
        physical.add(displayFieldName(field, locale));
      }
    } else {
      physical.add(field.name);
    }
  }
  for (const name of Object.keys(below ?? {})) {
    physical.add(name);
  }
  return [...physical];
}

/** Fetch a level’s referents by IRI, batched, as flat engine documents. */
async function fetchReferents(
  client: Pick<Client, 'multiSearch'>,
  collection: string,
  iris: readonly string[],
  include: readonly string[],
  onError?: (error: unknown) => void,
): Promise<ReadonlyMap<string, Record<string, unknown>>> {
  const documents = new Map<string, Record<string, unknown>>();
  const searches = [];
  for (let start = 0; start < iris.length; start += BATCH_SIZE) {
    const batch = iris.slice(start, start + BATCH_SIZE);
    searches.push({
      collection,
      q: '*',
      filter_by: `id:[${batch.map(escapeFilterValue).join(',')}]`,
      include_fields: include.join(','),
      per_page: batch.length,
    });
  }
  try {
    const { results } = (await client.multiSearch.perform({ searches })) as {
      results: readonly {
        hits?: readonly { document: Record<string, unknown> }[];
        error?: string;
      }[];
    };
    for (const result of results) {
      // multi_search reports a failed entry inline instead of rejecting;
      // isolate it, so the other batches' referents still land.
      if (result.error !== undefined) {
        onError?.(
          new Error(
            `Typesense reference lookup in “${collection}” failed: ${result.error}`,
          ),
        );
        continue;
      }
      for (const hit of result.hits ?? []) {
        documents.set(String(hit.document.id), hit.document);
      }
    }
  } catch (error) {
    onError?.(error);
  }
  return documents;
}
