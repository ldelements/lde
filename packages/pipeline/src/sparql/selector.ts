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
import { classifyOutcome } from './failure.js';
import { withDefaultGraph } from './graph.js';
import type { VariableBindings } from './reader.js';
import { ConstantTimeoutPolicy, type TimeoutPolicy } from './timeoutPolicy.js';

/**
 * Fallback policy when no per-call `TimeoutPolicy` is supplied via
 * {@link SelectOptions.timeout}. Pipeline always supplies one, so this only
 * matters when the selector is driven directly (without a Pipeline).
 */
const defaultTimeoutPolicy: TimeoutPolicy = new ConstantTimeoutPolicy(300_000);

/**
 * Bindings per SELECT request unless the stage’s batches are larger: few
 * enough IRIs to hold cheaply, many enough that selection stops costing a
 * round trip per batch. Measured on a QLever import of 17574 roots, one SELECT
 * for all of them was no faster than pages of 1000.
 */
const defaultPageSize = 1000;

const parser = new Parser();
const generator = new Generator();
const F = new AstFactory();

export interface SparqlItemSelectorOptions {
  /**
   * SELECT query projecting at least one named variable.
   *
   * A `LIMIT` clause in the query overrides {@link pageSize} – use this when
   * the SPARQL endpoint enforces a result limit.
   * It does **not** cap the total number of bindings the selector yields;
   * pagination continues with `OFFSET` until the source is exhausted. Use
   * {@link maxResults} to cap the total.
   */
  query: string;
  /**
   * Maximum number of bindings the selector yields across all pages.
   * Use this for sampling – “give me at most N items, don’t walk the full
   * source”. Independent of {@link query}’s `LIMIT`, which controls page
   * size. Pagination stops as soon as `maxResults` bindings have been
   * yielded. Must not be negative.
   */
  maxResults?: number;
  /**
   * Bindings per SELECT request. The stage cuts each page into batches of
   * its `batchSize`, so a page larger than a batch saves the stage a SELECT
   * round trip before every batch. Each page is held in memory until the
   * stage has taken all its bindings. Must be a positive integer.
   *
   * @default the larger of the stage’s `batchSize` and 1000
   */
  pageSize?: number;
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
 * The endpoint URL comes from the {@link Distribution} passed to {@link select},
 * as does the graph to scope to: a distribution declaring a `namedGraph` selects
 * within that graph (a `FROM` clause), the same scoping `SparqlConstructReader`
 * applies to the extraction. The two must scope alike, or the roots come from a
 * wider source than the quads read for them.
 * Pagination is an internal detail – consumers iterate binding rows directly.
 *
 * The page size (results per SPARQL request) is determined by, in order:
 * 1. A `LIMIT` clause in the selector query (for endpoints with hard result limits)
 * 2. {@link SparqlItemSelectorOptions.pageSize}
 * 3. The larger of the stage’s {@link StageOptions.batchSize} (passed via
 *    {@link select}) and {@link defaultPageSize}
 *
 * Each page is read in full before its first binding is yielded, so the
 * request is done before the stage starts extracting the page’s batches: a
 * slow consumer never holds a response open. Memory is bounded by the page
 * size.
 *
 * The page size and the batch size must be positive – a page size of 0 could
 * never terminate, so it is rejected as a configuration error.
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
  private readonly pageSize?: number;
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

    if (
      options.pageSize !== undefined &&
      !isPositiveInteger(options.pageSize)
    ) {
      throw new Error(
        `pageSize must be a positive integer; got ${options.pageSize}`,
      );
    }

    this.parsed = parsed as QuerySelect;
    this.queryLimit = this.parsed.solutionModifiers.limitOffset?.limit;
    if (this.queryLimit !== undefined && this.queryLimit <= 0) {
      throw new Error(
        `Page size must be positive; got the query’s LIMIT ${this.queryLimit}`,
      );
    }
    this.variableNames = variables.map((variable) => variable.value);
    this.maxResults = options.maxResults;
    this.pageSize = options.pageSize;
    this.userFetcher = options.fetcher;
  }

  async *select(
    distribution: Distribution,
    batchSize?: number,
    options?: SelectOptions,
  ): AsyncIterableIterator<VariableBindings> {
    if (this.maxResults === 0) return;
    if (batchSize !== undefined && !isPositiveInteger(batchSize)) {
      throw new Error(
        `Batch size must be a positive integer; got ${batchSize}`,
      );
    }
    const basePageSize =
      this.queryLimit ??
      this.pageSize ??
      Math.max(batchSize ?? defaultPageSize, defaultPageSize);
    const endpoint = distribution.accessUrl!;
    // Per call, so concurrent selections over different datasets cannot see
    // each other's graph scope or page window.
    const query = structuredClone(this.parsed);
    if (distribution.namedGraph) {
      withDefaultGraph(query, distribution.namedGraph);
    }
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
      query.solutionModifiers.limitOffset = F.solutionModifierLimitOffset(
        effectivePageSize,
        offset,
        F.gen(),
      );
      const paginatedQuery = generator.generate(query);

      const page = await this.fetchPage(endpoint, paginatedQuery, policy);

      // Fetched rows drive pagination, yielded rows only `maxResults` – see
      // the class JSDoc for why dropped rows must keep their page slot.
      const fetched = page.length;
      for (const record of page) {
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
   * Run a single SPARQL request and read its whole page, so the response is
   * closed before the stage starts on the page’s batches. Threads the per-call
   * timeout from {@link TimeoutPolicy.beforeRequest} and reports the outcome
   * to {@link TimeoutPolicy.afterRequest} once the page is read, so the body
   * transfer counts towards the duration and a failure mid-body is reported.
   */
  private async fetchPage(
    endpoint: URL,
    paginatedQuery: string,
    policy: TimeoutPolicy,
  ): Promise<Record<string, Term>[]> {
    const timeoutMs = policy.beforeRequest({ endpoint });
    const fetcher =
      this.userFetcher ?? new SparqlEndpointFetcher({ timeout: timeoutMs });
    const start = Date.now();
    try {
      const stream = (await fetcher.fetchBindings(
        endpoint.toString(),
        paginatedQuery,
      )) as AsyncIterable<Record<string, Term>>;
      const page: Record<string, Term>[] = [];
      for await (const record of stream) {
        page.push(record);
      }
      policy.afterRequest({
        endpoint,
        outcome: 'ok',
        durationMs: Date.now() - start,
      });
      return page;
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

function isPositiveInteger(value: number): boolean {
  return Number.isInteger(value) && value > 0;
}

function isVariableTerm(v: object): v is TermVariable {
  return (
    'type' in v &&
    v.type === 'term' &&
    'subType' in v &&
    v.subType === 'variable'
  );
}
