import type { Client } from 'typesense';

/** The backtick-escaped ids of a `filter_by: id:[…]` clause – the wire form
 *  `escapeFilterValue` produces. */
export function filterByIds(filterBy: string): string[] {
  return [...filterBy.matchAll(/`([^`]+)`/g)].map((match) => match[1]);
}

/** An entry answerer that resolves a label lookup from `docsById`: the
 *  requested ids that exist come back as label documents. */
export function labelLookup(
  docsById: Record<string, Record<string, unknown>>,
): (search: Record<string, unknown>) => Record<string, unknown> {
  return (search) => {
    const hits = filterByIds(String(search.filter_by))
      .filter((id) => docsById[id] !== undefined)
      .map((id) => ({ document: { id, ...docsById[id] } }));
    return { found: hits.length, hits };
  };
}

export interface FakeTypesenseClientOptions {
  /**
   * Answer for a root search. The engine dispatches one through `multi_search`
   * (POST) like every other query – a GET could not carry a long `filter_by` –
   * so this answers the compiled entries, told apart from a label lookup by the
   * `query_by_weights` only {@link buildSearchParams} emits.
   */
  readonly searchResponse?: Record<string, unknown>;
  /** The documents export endpoint (JSONL) per collection; calls are counted. */
  readonly exportJsonl?: (collection: string) => Promise<string>;
  /** Answers one `multi_search` entry (an inline `{ error }` entry included);
   *  a throw rejects the whole perform. */
  readonly multiSearch?: (
    search: Record<string, unknown>,
    index: number,
  ) => Record<string, unknown>;
}

export interface FakeTypesenseClient {
  readonly client: Client;
  /** Every `multi_search` POST’s `searches` array, in call order, so batching
   *  is observable. Includes the root search, which travels the same way. */
  readonly performs: readonly (readonly Record<string, unknown>[])[];
  /** Just the label-lookup performs – those carrying no compiled query
   *  (`query_by_weights`) – so a test can count label round-trips without
   *  counting the root search that triggered them. */
  readonly labelPerforms: () => readonly (readonly Record<string, unknown>[])[];
  /** How often the documents export endpoint was called, so the label cache’s
   *  load behaviour is observable. */
  readonly exportCalls: () => number;
}

/**
 * A configurable fake Typesense client covering the three endpoints the
 * engine touches: document search, documents export (the label cache), and
 * `multi_search` (facet batches and label lookups). Unconfigured endpoints
 * reject, so a test never silently exercises a path it did not declare.
 */
export function fakeTypesenseClient(
  options: FakeTypesenseClientOptions = {},
): FakeTypesenseClient {
  const performs: (readonly Record<string, unknown>[])[] = [];
  let exportCalls = 0;
  const client = {
    collections: (name?: string) => ({
      documents: () => ({
        // No `search`: every query the engine issues – root, facet batch and
        // label lookup alike – goes through `multi_search` below.
        export: () => {
          exportCalls += 1;
          return options.exportJsonl === undefined
            ? Promise.reject(new Error('No exportJsonl configured.'))
            : options.exportJsonl(String(name));
        },
      }),
    }),
    multiSearch: {
      perform: async (request: { searches: Record<string, unknown>[] }) => {
        performs.push(request.searches);
        return {
          results: request.searches.map((search, index) => {
            // A compiled root/facet search carries query_by_weights; a label
            // lookup does not. So `searchResponse` answers the former without
            // shadowing a configured label-lookup answerer.
            if (
              options.searchResponse !== undefined &&
              'query_by_weights' in search
            ) {
              return options.searchResponse;
            }
            if (options.multiSearch === undefined) {
              throw new Error('No multiSearch configured.');
            }
            return options.multiSearch(search, index);
          }),
        };
      },
    },
  };
  return {
    client: client as unknown as Client,
    performs,
    labelPerforms: () =>
      performs.filter(
        (searches) => !searches.some((search) => 'query_by_weights' in search),
      ),
    exportCalls: () => exportCalls,
  };
}
