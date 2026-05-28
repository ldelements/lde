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
import type { VariableBindings } from './executor.js';
import {
  ConstantTimeoutPolicy,
  type TimeoutOutcome,
  type TimeoutPolicy,
} from './timeoutPolicy.js';

const transientStatusPattern = /HTTP status (\d+)/;

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
   * yielded.
   */
  maxResults?: number;
  /** Custom fetcher instance. */
  fetcher?: SparqlEndpointFetcher;
  /**
   * Per-attempt timeout policy. Defaults to
   * `new ConstantTimeoutPolicy(300_000)` so callers that supply nothing
   * keep today’s 5-minute budget.
   *
   * Overridden by {@link SelectOptions.timeout} when the Pipeline
   * threads a per-dataset policy through.
   */
  timeout?: TimeoutPolicy;
}

/**
 * {@link ItemSelector} that pages through SPARQL SELECT results,
 * yielding all projected variable bindings (NamedNode values only) per row.
 *
 * The endpoint URL comes from the {@link Distribution} passed to {@link select}.
 * Pagination is an internal detail — consumers iterate binding rows directly.
 *
 * The page size (results per SPARQL request) is determined by, in order:
 * 1. A `LIMIT` clause in the selector query (for endpoints with hard result limits)
 * 2. The stage's {@link StageOptions.batchSize} (passed via {@link select})
 * 3. A default of 10
 *
 * {@link SparqlItemSelectorOptions.maxResults} is independent of page size:
 * it caps the *total* bindings yielded across pages without changing how
 * the first page is requested. The last (partial) page’s `LIMIT` is
 * shrunk to whatever’s left of the cap so the endpoint doesn’t over-fetch
 * on the remainder.
 */
export class SparqlItemSelector implements ItemSelector {
  private readonly parsed: QuerySelect;
  private readonly queryLimit?: number;
  private readonly maxResults?: number;
  private readonly userFetcher?: SparqlEndpointFetcher;
  private readonly defaultPolicy: TimeoutPolicy;

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

    this.parsed = parsed as QuerySelect;
    this.queryLimit = this.parsed.solutionModifiers.limitOffset?.limit;
    this.maxResults = options.maxResults;
    this.userFetcher = options.fetcher;
    this.defaultPolicy = options.timeout ?? new ConstantTimeoutPolicy(300_000);
  }

  async *select(
    distribution: Distribution,
    batchSize?: number,
    options?: SelectOptions,
  ): AsyncIterableIterator<VariableBindings> {
    if (this.maxResults === 0) return;
    const basePageSize = this.queryLimit ?? batchSize ?? 10;
    const endpoint = distribution.accessUrl!;
    const policy = options?.timeout ?? this.defaultPolicy;
    let offset = 0;
    let totalYielded = 0;

    while (true) {
      const remaining =
        this.maxResults !== undefined
          ? this.maxResults - totalYielded
          : Infinity;
      // The first page uses the configured page size as-is — keeps page-size
      // and total-cap orthogonal. Subsequent pages clamp to `remaining` so
      // the last (partial) page doesn’t over-fetch.
      const effectivePageSize =
        offset === 0 ? basePageSize : Math.min(basePageSize, remaining);
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

      let count = 0;
      for await (const record of stream) {
        const row = Object.fromEntries(
          Object.entries(record).filter(
            ([, term]) => term.termType === 'NamedNode',
          ),
        ) as VariableBindings;

        if (Object.keys(row).length > 0) {
          yield row;
          count++;
          totalYielded++;
          if (
            this.maxResults !== undefined &&
            totalYielded >= this.maxResults
          ) {
            return;
          }
        }
      }

      if (count === 0 || count < effectivePageSize) {
        return;
      }

      offset += count;
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
