import DataLoader from 'dataloader';
import type { Facet, RootType, SearchEngine, SearchQuery } from '@lde/search';

/**
 * Resolves one selected facet field to its facet; see {@link createFacetLoader}.
 * `matching` computes it over the documents the other filters leave
 * (skip-own-filter), `all` over the whole collection, ignoring the query’s
 * filters and text – the extent a range slider is drawn across.
 */
export type FacetLoader = (field: string, scope: FacetScope) => Promise<Facet>;

/** Which documents a {@link FacetLoader} computes a facet over. */
export type FacetScope = 'matching' | 'all';

/**
 * A per-request batcher behind the keyed facets object. Each selected facet
 * field’s resolver calls the loader; GraphQL resolves the sibling facet
 * fields synchronously, so the loads land in the same tick, where the
 * DataLoader collects them into one batch: one facet-only query over the
 * listing’s `query` for every `matching` load, and one over
 * `unfilteredQuery` – the deployment’s policy without the caller’s filters –
 * for every `all` load, dispatched as ONE `engine.searchFacets` call. The
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
      const queries = (
        [
          ['matching', query],
          ['all', unfilteredQuery],
        ] as const
      )
        .map(([scope, scopeQuery]) => ({
          scope,
          // `searchFacets` answers every query facet-only, whatever its
          // `orderBy`, `limit` and `offset`.
          facetQuery: {
            ...scopeQuery,
            // DataLoader has already deduplicated the keys.
            facets: keys
              .filter((key) => key.scope === scope)
              .map((key) => key.field),
          },
        }))
        .filter(({ facetQuery }) => facetQuery.facets.length > 0);
      const facets = new Map<string, Facet>();
      // A range facet loaded in both scopes fails in two queries but is
      // reported once.
      const failed = new Map<string, unknown>();
      try {
        const outcomes = await engine.searchFacets(
          searchType,
          queries.map(({ facetQuery }) => facetQuery),
        );
        queries.forEach(({ scope, facetQuery }, index) => {
          const outcome = outcomes[index];
          if (outcome !== undefined && !('error' in outcome)) {
            for (const field of facetQuery.facets) {
              facets.set(
                cacheKeyOf({ field, scope }),
                outcome.facets[field] ?? EMPTY_FACET,
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
  return (field, scope) => loader.load({ field, scope });
}

/** One facet load: a field, over the documents a scope names. */
interface FacetKey {
  readonly field: string;
  readonly scope: FacetScope;
}

/** A field name never contains a space, so this cannot conflate two keys. */
function cacheKeyOf(key: FacetKey): string {
  return `${key.scope} ${key.field}`;
}

/** What a facet degrades to: no buckets, and no extent. */
const EMPTY_FACET: Facet = { buckets: [] };
