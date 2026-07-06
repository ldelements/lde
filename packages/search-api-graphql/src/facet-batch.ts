import DataLoader from 'dataloader';
import type {
  FacetBucket,
  SearchEngine,
  SearchQuery,
  SearchType,
} from '@lde/search';

/** Resolves one selected facet field to its buckets; see {@link createFacetLoader}. */
export type FacetLoader = (field: string) => Promise<readonly FacetBucket[]>;

/**
 * A per-request batcher behind the keyed facets object. Each selected facet
 * field’s resolver calls the loader; GraphQL resolves the sibling facet
 * fields synchronously, so the loads land in the same tick, where the
 * DataLoader collects them into one batch, which is grouped into the fewest
 * equivalent queries ({@link groupFacetQueries}) and dispatched as ONE
 * `engine.searchFacets` call — one engine round-trip for the whole sidebar
 * instead of one search per facet.
 *
 * A facet is supplementary: a failed facet query degrades exactly its own
 * facets to empty lists — reported per field via `onFacetError` — while its
 * siblings keep their buckets; only a batch-level failure (the dispatch
 * itself rejecting) degrades every facet. Neither fails the whole GraphQL
 * query, which would null the non-null result and discard the items.
 */
export function createFacetLoader(
  engine: SearchEngine,
  searchType: SearchType,
  query: SearchQuery,
  onFacetError?: (field: string, error: unknown) => void,
): FacetLoader {
  const loader = new DataLoader<string, readonly FacetBucket[]>(
    async (fields) => {
      const queries = groupFacetQueries(query, fields);
      const buckets = new Map<string, readonly FacetBucket[]>();
      try {
        const outcomes = await engine.searchFacets(searchType, queries);
        queries.forEach((facetQuery, index) => {
          const outcome = outcomes[index];
          if (outcome !== undefined && !('error' in outcome)) {
            for (const field of facetQuery.facets) {
              buckets.set(field, outcome.facets[field] ?? []);
            }
            return;
          }
          // A failed (or missing — a port-contract breach) outcome degrades
          // exactly this query's facets; its siblings keep theirs.
          const error =
            outcome === undefined
              ? new Error('The engine returned no outcome for this query.')
              : outcome.error;
          for (const field of facetQuery.facets) {
            onFacetError?.(field, error);
          }
        });
      } catch (error) {
        // A batch-level failure leaves `buckets` empty: every facet in the
        // batch degrades to [].
        for (const field of fields) {
          onFacetError?.(field, error);
        }
      }
      return fields.map((field) => buckets.get(field) ?? []);
    },
  );
  return (field) => loader.load(field);
}

/**
 * Group the selected facet fields into the fewest facet-only queries with
 * unchanged skip-own-filter semantics. Each facet counts with its OWN
 * `where`-filter removed, so removal only matters for a facet whose field is
 * actively filtered: every facet whose field carries no filter shares the
 * untouched `where` — one query faceting all of them (the unfiltered browse
 * collapses to a single query) — while each own-filtered facet gets its own
 * query with its own effective `where`. (Dropping a facet’s filter also drops
 * a policy default on that field, e.g. valid-only `status`, so the facet
 * counts across every value.) The queries are facet-only: no hits (`limit:
 * 0`) and, with no hits to order, no `orderBy`.
 */
export function groupFacetQueries(
  query: SearchQuery,
  fields: readonly string[],
): SearchQuery[] {
  const filteredFields = new Set(query.where.map((filter) => filter.field));
  const facetOnly: SearchQuery = { ...query, orderBy: [], limit: 0, offset: 0 };
  const sharedFields = fields.filter((field) => !filteredFields.has(field));
  const queries: SearchQuery[] = [];
  if (sharedFields.length > 0) {
    queries.push({ ...facetOnly, facets: sharedFields });
  }
  for (const field of fields.filter((field) => filteredFields.has(field))) {
    queries.push({
      ...facetOnly,
      where: query.where.filter((filter) => filter.field !== field),
      facets: [field],
    });
  }
  return queries;
}
