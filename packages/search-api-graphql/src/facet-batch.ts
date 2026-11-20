import DataLoader from 'dataloader';
import type { Facet, RootType, SearchEngine, SearchQuery } from '@lde/search';

/**
 * Resolves one selected facet field to its facet; see {@link createFacetLoader}.
 * `matching` computes it over the documents the other filters leave
 * (skip-own-filter), `all` over the whole collection, ignoring the query’s
 * filters and text – the extent a range slider is drawn across.
 */
export type FacetLoader = (
  field: string,
  scope: FacetScope,
  limit?: number,
  query?: string,
) => Promise<Facet>;

/** Which documents a {@link FacetLoader} computes a facet over. */
export type FacetScope = 'matching' | 'all';

/**
 * A per-request batcher behind the keyed facets object. Each selected facet
 * field’s resolver calls the loader; GraphQL resolves the sibling facet
 * fields synchronously, so the loads land in the same tick, where the
 * DataLoader collects them into one batch: one facet-only query over the
 * listing’s `query` for the `matching` loads, and one over
 * `unfilteredQuery` – the deployment’s policy without the caller’s filters –
 * for the `all` loads, dispatched as ONE `engine.searchFacets` call. Each
 * load’s bucket `limit` travels in the query’s `facetLimits`, and its text
 * `query` in its `facetQueries`; only the same field loaded twice with
 * different limits or queries (two aliases) needs a second query in its
 * scope. The
 * engine counts each facet without its own filter (skip-own-filter) and keeps
 * its selected values among the buckets, so the whole sidebar costs one
 * engine round-trip.
 *
 * A facet is supplementary: a failed query degrades all of its facets to
 * empty – one search behind any of them failing is enough – reported once per
 * field via `onFacetError`, while the other query keeps its facets; a batch-level failure (the dispatch itself
 * rejecting) degrades every facet. Neither fails the whole GraphQL query,
 * which would null the non-null result and discard the items.
 */
export function createFacetLoader(
  engine: SearchEngine,
  searchType: RootType,
  query: SearchQuery,
  unfilteredQuery: SearchQuery,
  onFacetError?: (field: string, error: unknown) => void,
): FacetLoader {
  const loader = new DataLoader<FacetKey, Facet, string>(
    async (keys) => {
      const scopeQueries = { matching: query, all: unfilteredQuery };
      // The `matching` queries first; a key joins the first query of its
      // scope that does not count its field yet. DataLoader has already
      // deduplicated the keys.
      const groups: { scope: FacetScope; keys: FacetKey[] }[] = [];
      for (const scope of ['matching', 'all'] as const) {
        for (const key of keys.filter((key) => key.scope === scope)) {
          let group = groups.find(
            (candidate) =>
              candidate.scope === scope &&
              !candidate.keys.some((other) => other.field === key.field),
          );
          if (group === undefined) {
            group = { scope, keys: [] };
            groups.push(group);
          }
          group.keys.push(key);
        }
      }
      const queries = groups.map(({ scope, keys: groupKeys }) => {
        const limited = groupKeys.filter((key) => key.limit !== undefined);
        const queried = groupKeys.filter((key) => key.query !== undefined);
        return {
          keys: groupKeys,
          // `searchFacets` answers every query facet-only, whatever its
          // `orderBy`, `limit` and `offset`.
          facetQuery: {
            ...scopeQueries[scope],
            facets: groupKeys.map((key) => key.field),
            ...(limited.length > 0 && {
              facetLimits: Object.fromEntries(
                limited.map((key) => [key.field, key.limit as number]),
              ),
            }),
            ...(queried.length > 0 && {
              facetQueries: Object.fromEntries(
                queried.map((key) => [key.field, key.query as string]),
              ),
            }),
          },
        };
      });
      const facets = new Map<string, Facet>();
      // A range facet loaded in both scopes fails in two queries but is
      // reported once.
      const failed = new Map<string, unknown>();
      try {
        const outcomes = await engine.searchFacets(
          searchType,
          queries.map(({ facetQuery }) => facetQuery),
        );
        queries.forEach(({ keys: groupKeys, facetQuery }, index) => {
          const outcome = outcomes[index];
          if (outcome !== undefined && !('error' in outcome)) {
            for (const key of groupKeys) {
              facets.set(
                cacheKeyOf(key),
                outcome.facets[key.field] ?? EMPTY_FACET,
              );
            }
            return;
          }
          // A failed (or missing – a port-contract breach) outcome degrades
          // exactly this query’s facets; the other query keeps its own.
          const error =
            outcome === undefined
              ? new Error('The engine returned no outcome for this query.')
              : outcome.error;
          for (const field of facetQuery.facets) {
            if (!failed.has(field)) {
              failed.set(field, error);
            }
          }
        });
      } catch (error) {
        // A batch-level failure leaves `facets` empty: every facet in the
        // batch degrades to empty, reported once however many scopes it
        // loaded.
        for (const key of keys) {
          failed.set(key.field, error);
        }
      }
      for (const [field, error] of failed) {
        onFacetError?.(field, error);
      }
      return keys.map((key) => facets.get(cacheKeyOf(key)) ?? EMPTY_FACET);
    },
    { cacheKeyFn: cacheKeyOf },
  );
  return (field, scope, limit, query) =>
    loader.load({ field, scope, limit, query });
}

/** One facet load: a field, over the documents a scope names, capped at
 *  `limit` buckets (absent: the engine’s default) and, with a `query`,
 *  only the values matching it. */
interface FacetKey {
  readonly field: string;
  readonly scope: FacetScope;
  readonly limit?: number;
  readonly query?: string;
}

/** Every part of the key, so no two loads are conflated. */
function cacheKeyOf(key: FacetKey): string {
  return JSON.stringify([
    key.scope,
    key.limit ?? null,
    key.query ?? null,
    key.field,
  ]);
}

/** What a facet degrades to: no buckets, and no extent. */
const EMPTY_FACET: Facet = { buckets: [] };
