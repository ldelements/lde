import { Dataset, Distribution, assertSafeIri } from '@lde/dataset';
import { SparqlEndpointFetcher } from 'fetch-sparql-endpoint';
import type { NamedNode, Quad } from '@rdfjs/types';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { Transform } from 'node:stream';
import { StreamParser } from 'n3';
import { Parser } from '@traqula/parser-sparql-1-1';
import { Generator } from '@traqula/generator-sparql-1-1';
import type { QueryConstruct } from '@traqula/rules-sparql-1-1';
import isNetworkError from 'is-network-error';
import pRetry from 'p-retry';
import { quadToStringQuad } from 'rdf-string';
import { withDefaultGraph } from './graph.js';
import { injectValues } from './values.js';
import {
  ConstantTimeoutPolicy,
  type TimeoutOutcome,
  type TimeoutPolicy,
} from './timeoutPolicy.js';

/**
 * An executor could not run because the dataset lacks a supported distribution.
 */
export class NotSupported {
  constructor(public readonly message: string) {}
}

/** A single row of variable bindings (variable name → NamedNode). */
export type VariableBindings = Record<string, NamedNode>;

export interface ExecuteOptions {
  /**
   * Variable bindings to inject as a VALUES clause into the query.
   * When non-empty, a VALUES block is prepended to the WHERE clause.
   */
  bindings?: VariableBindings[];

  /**
   * Per-call {@link TimeoutPolicy}. When supplied, the executor calls
   * {@link TimeoutPolicy.beforeRequest} once per attempt (including
   * retries), installs an {@link AbortSignal} with the returned budget,
   * and reports the outcome via {@link TimeoutPolicy.afterRequest}.
   *
   * Overrides the executor-level policy passed at construction time.
   * Pipeline runners use this to thread the per-dataset policy through.
   */
  timeout?: TimeoutPolicy;
}

export interface Executor {
  execute(
    dataset: Dataset,
    distribution: Distribution,
    options?: ExecuteOptions,
  ): Promise<AsyncIterable<Quad> | NotSupported>;
}

/**
 * Options for SparqlConstructExecutor.
 */
export interface SparqlConstructExecutorOptions {
  /**
   * SPARQL CONSTRUCT query to execute.
   */
  query: string;

  /**
   * Per-attempt timeout policy. Defaults to
   * `new ConstantTimeoutPolicy(300_000)` so callers that supply nothing get
   * the same 5-minute budget as before — but expressed through the new
   * {@link TimeoutPolicy} surface so an adaptive policy can be slotted in
   * via {@link ExecuteOptions.timeout} without changing this default.
   *
   * Replaces the old `timeout: number` option. Call sites passing
   * `timeout: 5000` migrate to
   * `timeout: constantTimeoutPolicy(5_000)()`.
   */
  timeout?: TimeoutPolicy;

  /**
   * Number of retries for transient errors (network failures and HTTP 502/503/504).
   * @default 3
   */
  retries?: number;

  /**
   * Optional custom SparqlEndpointFetcher instance.
   *
   * When supplied, the executor uses this fetcher for every attempt. The
   * per-attempt timeout from the policy is still applied via an
   * {@link AbortSignal} on the underlying fetch (provided the supplied
   * fetcher honours `init.signal`).
   *
   * When omitted, the executor builds a fresh
   * {@link SparqlEndpointFetcher} per attempt with the per-attempt timeout
   * baked in.
   */
  fetcher?: SparqlEndpointFetcher;

  /**
   * Buffer complete lines before passing them to the N3 parser.
   *
   * Works around an [N3.js bug](https://github.com/rdfjs/N3.js/issues/578)
   * where language tags (e.g. `@nl-nl`) split across HTTP chunk boundaries
   * cause parse errors. Enable this when querying endpoints that return
   * line-oriented formats such as N-Triples (e.g. QLever).
   *
   * @default false
   */
  lineBuffer?: boolean;

  /**
   * Deduplicate triples in the CONSTRUCT output stream.
   *
   * SPARQL CONSTRUCT queries can produce duplicate triples — for example,
   * constant triples (like `?dataset a edm:ProvidedCHO`) are emitted for
   * every solution row. When enabled, a streaming identity filter removes
   * duplicates inline without buffering.
   *
   * The dedup set is scoped to each {@link execute} call, so memory stays
   * bounded to the number of unique quads per call (typically one batch).
   *
   * Inspired by Comunica's `distinctConstruct` context option.
   *
   * @default false
   */
  deduplicate?: boolean;
}

/**
 * A streaming SPARQL CONSTRUCT executor.
 *
 * Queries **without** `#subjectFilter#` are parsed once in the constructor
 * (fast path). Queries that contain the template are stored as raw strings
 * and parsed at {@link execute} time after substitution.
 *
 * Template substitution (applied in order):
 * 1. `#subjectFilter#` — replaced with `distribution.subjectFilter` (deferred to execute)
 * 2. `FROM <graph>` — set via `withDefaultGraph` if the distribution has a named graph
 * 3. `?dataset` — replaced with the dataset IRI (string substitution on the serialised query)
 *
 * @example
 * ```typescript
 * const executor = new SparqlConstructExecutor({
 *   query: 'CONSTRUCT { ?dataset ?p ?o } WHERE { ?s ?p ?o }',
 * });
 * const result = await executor.execute(dataset, distribution);
 * if (result instanceof NotSupported) {
 *   console.log(result.message);
 * } else {
 *   for await (const quad of result) {
 *     console.log(quad);
 *   }
 * }
 * ```
 */
export class SparqlConstructExecutor implements Executor {
  private readonly rawQuery: string;
  private readonly preParsed?: QueryConstruct;
  private readonly userFetcher?: SparqlEndpointFetcher;
  private readonly defaultPolicy: TimeoutPolicy;
  private readonly retries: number;
  private readonly lineBuffer: boolean;
  private readonly deduplicate: boolean;
  private readonly generator = new Generator();

  constructor(options: SparqlConstructExecutorOptions) {
    this.rawQuery = options.query;
    this.retries = options.retries ?? 3;
    this.lineBuffer = options.lineBuffer ?? false;
    this.deduplicate = options.deduplicate ?? false;

    if (!options.query.includes('#subjectFilter#')) {
      const parsed = new Parser().parse(options.query);
      if (parsed.type !== 'query' || parsed.subType !== 'construct') {
        throw new Error('Query must be a CONSTRUCT query');
      }
      this.preParsed = parsed as QueryConstruct;
    }

    this.userFetcher = options.fetcher;
    this.defaultPolicy = options.timeout ?? new ConstantTimeoutPolicy(300_000);
  }

  /**
   * Execute the SPARQL CONSTRUCT query against the distribution's endpoint.
   *
   * @param dataset The dataset to execute against.
   * @param distribution The distribution providing the SPARQL endpoint.
   * @param options Optional execution options (bindings).
   * @returns AsyncIterable<Quad> stream of results.
   */
  async execute(
    dataset: Dataset,
    distribution: Distribution,
    options?: ExecuteOptions,
  ): Promise<AsyncIterable<Quad>> {
    const endpoint = distribution.accessUrl;

    let ast: QueryConstruct;
    if (this.preParsed) {
      ast = structuredClone(this.preParsed);
    } else {
      const substituted = this.rawQuery.replaceAll(
        '#subjectFilter#',
        distribution.subjectFilter ?? '',
      );
      const parsed = new Parser().parse(substituted);
      if (parsed.type !== 'query' || parsed.subType !== 'construct') {
        throw new Error('Query must be a CONSTRUCT query');
      }
      ast = parsed as QueryConstruct;
    }

    if (distribution.namedGraph) {
      withDefaultGraph(ast, distribution.namedGraph);
    }

    const bindings = options?.bindings;
    if (bindings !== undefined && bindings.length > 0) {
      ast = injectValues(ast, bindings);
    }

    let query = this.generator.generate(ast);
    assertSafeIri(dataset.iri.toString());
    query = query.replaceAll('?dataset', `<${dataset.iri}>`);

    const policy = options?.timeout ?? this.defaultPolicy;
    const endpointUrl = endpoint;

    const quads = await pRetry(
      () => this.fetchQuadsWithPolicy(endpointUrl, query, policy),
      {
        retries: this.retries,
        shouldRetry: ({ error }) => isTransientError(error),
      },
    );

    return this.deduplicate ? deduplicateQuads(quads) : quads;
  }

  /**
   * Run a single attempt against the endpoint with a per-call abort
   * signal derived from {@link TimeoutPolicy.beforeRequest}. Reports the
   * outcome via {@link TimeoutPolicy.afterRequest} regardless of whether
   * the attempt resolved or threw.
   */
  private async fetchQuadsWithPolicy(
    endpointUrl: URL,
    query: string,
    policy: TimeoutPolicy,
  ): Promise<AsyncIterable<Quad>> {
    const timeoutMs = policy.beforeRequest({ endpoint: endpointUrl });
    const fetcher = this.fetcherForAttempt(timeoutMs);
    const start = Date.now();
    try {
      const quads = await this.fetchQuads(
        fetcher,
        endpointUrl.toString(),
        query,
      );
      policy.afterRequest({
        endpoint: endpointUrl,
        outcome: 'ok',
        durationMs: Date.now() - start,
      });
      return quads;
    } catch (error) {
      policy.afterRequest({
        endpoint: endpointUrl,
        outcome: classifyOutcome(error),
        durationMs: Date.now() - start,
        error,
      });
      throw error;
    }
  }

  /**
   * Pick the fetcher to use for a single attempt. When a user-supplied
   * fetcher is configured, it is used as-is — the policy timeout is still
   * applied if the user's underlying fetch honours `init.signal`, since
   * {@link SparqlEndpointFetcher} merges its own timeout signal with any
   * caller-supplied one only via construction. We therefore wrap the
   * user's fetcher only when no custom fetcher was provided.
   */
  private fetcherForAttempt(timeoutMs: number): SparqlEndpointFetcher {
    if (this.userFetcher) return this.userFetcher;
    return new SparqlEndpointFetcher({ timeout: timeoutMs });
  }

  /**
   * Fetch quads from the endpoint, optionally line-buffering the response
   * stream before it reaches the N3 parser to work around
   * {@link https://github.com/rdfjs/N3.js/issues/578 | N3.js#578}.
   */
  private async fetchQuads(
    fetcher: SparqlEndpointFetcher,
    endpoint: string,
    query: string,
  ): Promise<AsyncIterable<Quad>> {
    if (!this.lineBuffer) {
      return fetcher.fetchTriples(endpoint, query);
    }

    const [contentType, , responseStream] = await fetcher.fetchRawStream(
      endpoint,
      query,
      SparqlEndpointFetcher.CONTENTTYPE_TURTLE,
    );
    return responseStream
      .pipe(new LineBufferTransform())
      .pipe(new StreamParser({ format: contentType }));
  }

  /**
   * Create an executor from a query file.
   *
   * @param filename Path to the query file.
   * @param options Optional executor options (timeout, fetcher).
   */
  public static async fromFile(
    filename: string,
    options?: Omit<SparqlConstructExecutorOptions, 'query'>,
  ): Promise<SparqlConstructExecutor> {
    const query = await readQueryFile(filename);
    return new SparqlConstructExecutor({ ...options, query });
  }
}

/**
 * Read a SPARQL query from a file.
 */
export async function readQueryFile(filename: string): Promise<string> {
  return (await readFile(resolve(filename))).toString();
}

/**
 * Buffers incoming data until complete lines (`\n`-terminated) are available,
 * then pushes them downstream as a single chunk.
 *
 * **Why this exists:** `fetch-sparql-endpoint` pipes the raw HTTP response
 * stream directly into N3.js's `StreamParser`. N3.js has a bug
 * ({@link https://github.com/rdfjs/N3.js/issues/578 | N3.js#578}) where
 * tokens that straddle chunk boundaries — most commonly language tags like
 * `@nl-nl` — cause spurious `Unexpected "-nl"` parse errors. The error is
 * non-deterministic and typically surfaces only on responses larger than
 * ~12 MB, because that is when HTTP chunking starts splitting mid-token.
 *
 * By ensuring each chunk passed to the parser ends on a line boundary, we
 * prevent any N-Triples token from being split. Memory overhead is minimal:
 * at most one partial line is buffered at a time.
 *
 * This transform can be removed once N3.js#578 is fixed upstream.
 *
 * @see https://github.com/rdfjs/N3.js/issues/578
 */
export class LineBufferTransform extends Transform {
  private remainder = '';

  override _transform(chunk: Buffer, _encoding: string, callback: () => void) {
    const data = this.remainder + chunk.toString();
    const lines = data.split('\n');
    this.remainder = lines.pop() ?? '';
    if (lines.length > 0) {
      this.push(lines.join('\n') + '\n');
    }
    callback();
  }

  override _flush(callback: () => void) {
    if (this.remainder.length > 0) {
      this.push(this.remainder);
    }
    callback();
  }
}

/**
 * Remove duplicate quads from an async quad stream.
 *
 * Uses string-based identity (the same approach as Comunica's
 * `distinctConstruct`): each quad is serialised via
 * [`rdf-string`](https://github.com/rubensworks/rdf-string.js) and checked
 * against a {@link Set}. Only the first occurrence of each unique quad is
 * yielded.
 *
 * @example
 * ```typescript
 * const unique = deduplicateQuads(quadStream);
 * for await (const quad of unique) {
 *   // each quad appears at most once
 * }
 * ```
 */
export async function* deduplicateQuads(
  quads: AsyncIterable<Quad>,
): AsyncIterable<Quad> {
  const seen = new Set<string>();
  for await (const quad of quads) {
    const key = Object.values(quadToStringQuad(quad)).join(' ');
    if (!seen.has(key)) {
      seen.add(key);
      yield quad;
    }
  }
}

const transientStatusPattern = /HTTP status (\d+)/;

function isTransientError(error: unknown): boolean {
  if (isNetworkError(error)) return true;
  if (!(error instanceof Error)) return false;
  const match = error.message.match(transientStatusPattern);
  if (!match) return false;
  const status = Number(match[1]);
  return status === 502 || status === 503 || status === 504;
}

/**
 * Classify a fetch error for {@link TimeoutPolicy} reporting.
 *
 * - HTTP 504 → `'timeout'`: the upstream reported it ran out of time. This
 *   is the exact failure mode adaptive timeouts exist to react to.
 * - `AbortError` / `TimeoutError`: our own `AbortSignal.timeout()` fired.
 * - Anything else → `'error'`: neutral with respect to tightening.
 */
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
