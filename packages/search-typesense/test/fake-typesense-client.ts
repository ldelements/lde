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
  /** Answer for `collections().documents().search()`. */
  readonly searchResponse?: Record<string, unknown>;
  /** The labels-collection export endpoint (JSONL); calls are counted. */
  readonly exportJsonl?: () => Promise<string>;
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
   *  is observable. */
  readonly performs: readonly (readonly Record<string, unknown>[])[];
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
    collections: () => ({
      documents: () => ({
        search: () =>
          Promise.resolve(options.searchResponse ?? { found: 0, hits: [] }),
        export: () => {
          exportCalls += 1;
          return options.exportJsonl === undefined
            ? Promise.reject(new Error('No exportJsonl configured.'))
            : options.exportJsonl();
        },
      }),
    }),
    multiSearch: {
      perform: async (request: { searches: Record<string, unknown>[] }) => {
        performs.push(request.searches);
        if (options.multiSearch === undefined) {
          throw new Error('No multiSearch configured.');
        }
        return { results: request.searches.map(options.multiSearch) };
      },
    },
  };
  return {
    client: client as unknown as Client,
    performs,
    exportCalls: () => exportCalls,
  };
}
