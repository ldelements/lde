import DataLoader from 'dataloader';
import type {
  FacetBucket,
  Filter,
  RootType,
  SearchEngine,
  SearchQuery,
} from '@lde/search';

/** Resolves one selected facet field to its buckets; see {@link createFacetLoader}. */
export type FacetLoader = (field: string) => Promise<readonly FacetBucket[]>;

/**
 * A per-request batcher behind the keyed facets object. Each selected facet
 * field’s resolver calls the loader; GraphQL resolves the sibling facet
 * fields synchronously, so the loads land in the same tick, where the
 * DataLoader collects them into one batch, which is grouped into the fewest
 * equivalent queries ({@link groupFacetQueries}) and dispatched as ONE
 * `engine.searchFacets` call – one engine round-trip for the whole sidebar
 * instead of one search per facet.
 *
 * A facet is supplementary: a failed facet query degrades exactly its own
 * facets to empty lists – reported per field via `onFacetError` – while its
 * siblings keep their buckets; only a batch-level failure (the dispatch
 * itself rejecting) degrades every facet. Neither fails the whole GraphQL
 * query, which would null the non-null result and discard the items.
 */
export function createFacetLoader(
  engine: SearchEngine,
  searchType: RootType,
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
          // A failed (or missing – a port-contract breach) outcome degrades
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
 * untouched `where` – one query faceting all of them (the unfiltered browse
 * collapses to a single query) – while each own-filtered facet gets its own
 * query with its own effective `where`. (Dropping a facet’s filter also drops
 * a policy default on that field, e.g. valid-only `status`, so the facet
 * counts across every value.) The queries are facet-only: no hits (`limit:
 * 0`) and, with no hits to order, no `orderBy`.
 *
 * A clause is a facet’s **own** only when it carries exactly one criterion, on
 * that field ({@link ownsFacet}). A disjunction (`or`) is nobody’s own and
 * always stays: the user constrained the document as a whole, never that one
 * axis, so there is no selection on it to widen. Keeping it is what leaves each facet
 * *complete on its own field* – every value it offers is one the user can pick,
 * with the count they will actually get. Dropping the clause’s own disjunct
 * instead would hide values that do return hits (on an entity page: the very
 * entity the page is about, absent from a sidebar beside results full of it),
 * and dropping it whole would count a corpus the sibling facets do not.
 * It also keeps a multi-field clause from ever splitting the batch.
 */
export function groupFacetQueries(
  query: SearchQuery,
  fields: readonly string[],
): SearchQuery[] {
  const filteredFields = new Set(
    query.where
      .map(ownedField)
      .filter((field): field is string => field !== undefined),
  );
  const facetOnly: SearchQuery = { ...query, orderBy: [], limit: 0, offset: 0 };
  const sharedFields = fields.filter((field) => !filteredFields.has(field));
  const queries: SearchQuery[] = [];
  if (sharedFields.length > 0) {
    queries.push({ ...facetOnly, facets: sharedFields });
  }
  for (const field of fields.filter((field) => filteredFields.has(field))) {
    queries.push({
      ...facetOnly,
      where: query.where.filter((filter) => !ownsFacet(filter, field)),
      facets: [field],
    });
  }
  return queries;
}

/** Whether a clause is `field`’s own – it constrains that field and nothing
 *  else, so skip-own-filter removes it when counting that facet. */
function ownsFacet(filter: Filter, field: string): boolean {
  return ownedField(filter) === field;
}

/**
 * The field a clause belongs to, or `undefined` when it belongs to none.
 *
 * A clause owns a field when **every** criterion names it – which covers the
 * ordinary one-criterion filter and equally a same-field disjunction
 * (`or: [{ created: { max: … } }, { created: { min: … } }]`, or a multi-select
 * spelled as alternatives). Those ARE a selection on one axis, so skip-own-filter
 * must drop them; leaving them in would compute the facet with the user’s own
 * selection applied, offering back only what they already picked.
 *
 * A clause spanning several fields is nobody’s own: the user constrained the
 * document as a whole, never one axis, so there is nothing on any single facet
 * to widen.
 */
function ownedField(filter: Filter): string | undefined {
  const [first, ...rest] = filter.or;
  if (first === undefined) {
    return undefined;
  }
  return rest.every((criterion) => criterion.field === first.field)
    ? first.field
    : undefined;
}
