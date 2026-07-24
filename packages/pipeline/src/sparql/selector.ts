import type { Distribution } from '@lde/dataset';
import type { Term } from '@rdfjs/types';
import { SparqlEndpointFetcher } from 'fetch-sparql-endpoint';
import { Parser } from '@traqula/parser-sparql-1-1';
import { Generator } from '@traqula/generator-sparql-1-1';
import {
  AstFactory,
  type QuerySelect,
  type TermVariable,
} from '@traqula/rules-sparql-1-1';
import type { ItemSelector, SelectOptions } from '../stage.js';
import type { VariableBindings } from './reader.js';
import {
  ConstantTimeoutPolicy,
  type TimeoutOutcome,
  type TimeoutPolicy,
} from './timeoutPolicy.js';

const transientStatusPattern = /HTTP status (\d+)/;

/**
 * Fallback policy when no per-call `TimeoutPolicy` is supplied via
 * {@link SelectOptions.timeout}. Pipeline always supplies one, so this only
 * matters when the selector is driven directly (without a Pipeline).
 */
const defaultTimeoutPolicy: TimeoutPolicy = new ConstantTimeoutPolicy(300_000);

const parser = new Parser();
const generator = new Generator();
const F = new AstFactory();

export interface SparqlItemSelectorOptions {
  /**
   * SELECT query projecting at least one named variable.
   *
   * A `LIMIT` clause in the query overrides the stage's `batchSize` as the
   * page size — use this when the SPARQL endpoint enforces a result limit.
   * It does **not** cap the total number of bindings the selector yields;
   * pagination continues with `OFFSET` until the source is exhausted. Use
   * {@link maxResults} to cap the total.
   */
  query: string;
  /**
   * Maximum number of bindings the selector yields across all pages.
   * Use this for sampling — “give me at most N items, don’t walk the full
   * source”. Independent of {@link query}’s `LIMIT`, which controls page
   * size. Pagination stops as soon as `maxResults` bindings have been
   * yielded. Must not be negative.
   */
  maxResults?: number;
  /** Custom fetcher instance. */
  fetcher?: SparqlEndpointFetcher;
}

/**
 * {@link ItemSelector} that pages through SPARQL SELECT results, yielding one
 * bindings row per result row. A row is yielded only when **every** projected
 * variable binds a NamedNode: binding values double as stable item identities
 * downstream and are re-injected into reader queries as a `VALUES` block,
 * which needs uniform rows – a blank-node label or literal provides no stable
 * identity, and a partially-bound row would silently weaken the join. Any
 * other row is dropped, but still counts toward pagination (it occupied a
 * result slot at the endpoint), so a partly-dropped page never ends
 * pagination early. Dropped rows are still fetched; to skip them at the
 * endpoint, filter in the query itself (e.g. `FILTER(isIRI(?s))`).
 *
 * The endpoint URL comes from the {@link Distribution} passed to {@link select}.
 * Pagination is an internal detail — consumers iterate binding rows directly.
 *
 * The page size (results per SPARQL request) is determined by, in order:
 * 1. A `LIMIT` clause in the selector query (for endpoints with hard result limits)
 * 2. The stage's {@link StageOptions.batchSize} (passed via {@link select})
 * 3. A default of 10
 *
 * The page size must be positive – a page size of 0 could never terminate,
 * so it is rejected as a configuration error.
 *
 * {@link SparqlItemSelectorOptions.maxResults} is independent of page size:
 * it caps the *total* bindings yielded across pages without changing how
 * the first page is requested. As long as no row has been dropped, the last
 * (partial) page’s `LIMIT` is shrunk to whatever’s left of the cap so the
 * endpoint doesn’t over-fetch on the remainder; once rows have been dropped,
 * pages stay at full size – shrinking them to the yielded remainder would
 * crawl a dropped-row region one row per request.
 */
export class SparqlItemSelector implements ItemSelector {
  private readonly parsed: QuerySelect;
  private readonly queryLimit?: number;
  private readonly variableNames: readonly string[];
  private readonly maxResults?: number;
  private readonly userFetcher?: SparqlEndpointFetcher;

  constructor(options: SparqlItemSelectorOptions) {
    const parsed = parser.parse(options.query);
    if (parsed.type !== 'query' || parsed.subType !== 'select') {
      throw new Error('Query must be a SELECT query');
    }

    const variables = (parsed as QuerySelect).variables.filter(isVariableTerm);
    if (variables.length === 0) {
      throw new Error(
        'Query must project at least one named variable (SELECT * is not supported)',
      );
    }

    if (options.maxResults !== undefined && options.maxResults < 0) {
      throw new Error(
        `maxResults must not be negative; got ${options.maxResults}`,
      );
    }

    this.parsed = parsed as QuerySelect;
    this.queryLimit = this.parsed.solutionModifiers.limitOffset?.limit;
    this.variableNames = variables.map((variable) => variable.value);
    this.maxResults = options.maxResults;
    this.userFetcher = options.fetcher;
  }

  async *select(
    distribution: Distribution,
    batchSize?: number,
    options?: SelectOptions,
  ): AsyncIterableIterator<VariableBindings> {
    if (this.maxResults === 0) return;
    const basePageSize = this.queryLimit ?? batchSize ?? 10;
    if (basePageSize <= 0) {
      throw new Error(
        `Page size must be positive; got ${basePageSize} (from the query’s LIMIT or the stage’s batchSize)`,
      );
    }
    const endpoint = distribution.accessUrl!;
    const policy = options?.timeout ?? defaultTimeoutPolicy;
    let offset = 0;
    let totalFetched = 0;
    let totalYielded = 0;

    while (true) {
      const remaining =
        this.maxResults !== undefined
          ? this.maxResults - totalYielded
          : Infinity;
      // The first page uses the configured page size as-is – keeps page-size
      // and total-cap orthogonal. Subsequent pages clamp to `remaining` so the
      // last (partial) page doesn’t over-fetch – but only while nothing has
      // been dropped: once yields lag fetches, clamping would crawl a
      // dropped-row region at down to one row per request (see class JSDoc).
      const effectivePageSize =
        offset === 0 || totalFetched > totalYielded
          ? basePageSize
          : Math.min(basePageSize, remaining);
      this.parsed.solutionModifiers.limitOffset = F.solutionModifierLimitOffset(
        effectivePageSize,
        offset,
        F.gen(),
      );
      const paginatedQuery = generator.generate(this.parsed);

      const stream = await this.fetchBindingsWithPolicy(
        endpoint,
        paginatedQuery,
        policy,
      );

      // Fetched rows drive pagination, yielded rows only `maxResults` – see
      // the class JSDoc for why dropped rows must keep their page slot.
      let fetched = 0;
      for await (const record of stream) {
        fetched++;
        totalFetched++;

        if (
          this.variableNames.every(
            (name) => record[name]?.termType === 'NamedNode',
          )
        ) {
          yield record as VariableBindings;
          totalYielded++;
          if (
            this.maxResults !== undefined &&
            totalYielded >= this.maxResults
          ) {
            return;
          }
        }
      }

      if (fetched < effectivePageSize) {
        return;
      }

      offset += fetched;
    }
  }

  /**
   * Run a single SPARQL request against the endpoint, threading the
   * per-call timeout from {@link TimeoutPolicy.beforeRequest} and
   * reporting the outcome to {@link TimeoutPolicy.afterRequest}.
   */
  private async fetchBindingsWithPolicy(
    endpoint: URL,
    paginatedQuery: string,
    policy: TimeoutPolicy,
  ): Promise<AsyncIterable<Record<string, Term>>> {
    const timeoutMs = policy.beforeRequest({ endpoint });
    const fetcher =
      this.userFetcher ?? new SparqlEndpointFetcher({ timeout: timeoutMs });
    const start = Date.now();
    try {
      const stream = (await fetcher.fetchBindings(
        endpoint.toString(),
        paginatedQuery,
      )) as AsyncIterable<Record<string, Term>>;
      policy.afterRequest({
        endpoint,
        outcome: 'ok',
        durationMs: Date.now() - start,
      });
      return stream;
    } catch (error) {
      policy.afterRequest({
        endpoint,
        outcome: classifyOutcome(error),
        durationMs: Date.now() - start,
        error,
      });
      throw error;
    }
  }
}

function classifyOutcome(error: unknown): TimeoutOutcome {
  if (error instanceof Error) {
    if (error.name === 'AbortError' || error.name === 'TimeoutError') {
      return 'timeout';
    }
    if (error.cause instanceof Error) {
      if (
        error.cause.name === 'AbortError' ||
        error.cause.name === 'TimeoutError'
      ) {
        return 'timeout';
      }
    }
    const match = error.message.match(transientStatusPattern);
    if (match && Number(match[1]) === 504) {
      return 'timeout';
    }
  }
  return 'error';
}

function isVariableTerm(v: object): v is TermVariable {
  return (
    'type' in v &&
    v.type === 'term' &&
    'subType' in v &&
    v.subType === 'variable'
  );
}
