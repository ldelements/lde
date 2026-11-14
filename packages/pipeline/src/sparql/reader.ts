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
import {
  createHostLimiter,
  endpointKeyOf,
  parseRetryAfter,
  type HostLimiter,
} from '@lde/host-limiter';
import { quadToStringQuad } from 'rdf-string';
import { withDefaultGraph } from './graph.js';
import { injectValues } from './values.js';
import { ConstantTimeoutPolicy, type TimeoutPolicy } from './timeoutPolicy.js';
import { classifyOutcome, isTransientError, statusOf } from './failure.js';

/**
 * Fallback policy when no per-call `TimeoutPolicy` is supplied via
 * {@link ReadOptions.timeout}. Pipeline always supplies one, so this only
 * matters when the reader is driven directly (without a Pipeline).
 */
const defaultTimeoutPolicy: TimeoutPolicy = new ConstantTimeoutPolicy(300_000);

/**
 * A reader could not run because the dataset lacks a supported distribution.
 */
export class NotSupported {
  constructor(public readonly message: string) {}
}

/**
 * A stage’s item selector selected nothing for the dataset, so the stage does
 * not apply to it – the usual outcome for a stage that only some datasets
 * have items for. A {@link NotSupported}, so callers that only check for that
 * keep treating it as a skip.
 */
export class NoItemsSelected extends NotSupported {
  constructor() {
    super('No items selected');
  }
}

/** A single row of variable bindings (variable name → NamedNode). */
export type VariableBindings = Record<string, NamedNode>;

export interface ReadOptions {
  /**
   * Variable bindings to inject as a VALUES clause into the query.
   * When non-empty, a VALUES block is prepended to the WHERE clause.
   */
  bindings?: VariableBindings[];

  /**
   * Per-call {@link TimeoutPolicy}. When supplied, the reader calls
   * {@link TimeoutPolicy.beforeRequest} once per attempt (including
   * retries), installs an {@link AbortSignal} with the returned budget,
   * and reports the outcome via {@link TimeoutPolicy.afterRequest}.
   *
   * Overrides the reader-level policy passed at construction time.
   * Pipeline runners use this to thread the per-dataset policy through.
   */
  timeout?: TimeoutPolicy;

  /**
   * The limiter every query of a read goes through, keyed on the endpoint
   * ({@link endpointKeyOf}), so every read on one endpoint shares one adaptive
   * limit and one pause. A pipeline passes its own. See
   * {@link SparqlConstructReader}.
   *
   * A read not given one gets a limiter for that read alone:
   * `createHostLimiter(10, 10)`. A {@link Stage} passes one for all its batches.
   */
  limiter?: HostLimiter;

  /**
   * Called for each root the endpoint failed on by itself: a query for that
   * one root still answered HTTP 500. The root is left out of the read, and
   * the rest of the batch is read without it.
   */
  onRootSkipped?: (root: VariableBindings, error: Error) => void;
}

export interface Reader {
  read(
    dataset: Dataset,
    distribution: Distribution,
    options?: ReadOptions,
  ): Promise<AsyncIterable<Quad> | NotSupported>;
}

/**
 * Options for SparqlConstructReader.
 */
export interface SparqlConstructReaderOptions {
  /**
   * SPARQL CONSTRUCT query to execute.
   */
  query: string;

  /**
   * Optional custom SparqlEndpointFetcher instance.
   *
   * When supplied, the reader uses this fetcher as-is for every attempt
   * – the per-attempt timeout from the {@link TimeoutPolicy} is **not**
   * enforced (the supplied fetcher’s own `timeout` governs). Policy
   * `beforeRequest`/`afterRequest` hooks still fire so outcome
   * classification works, but adaptive tightening cannot apply.
   *
   * When omitted, the reader builds a fresh
   * {@link SparqlEndpointFetcher} per attempt with the per-attempt timeout
   * baked in.
   *
   * This option is intended for tests (mocking `fetchTriples`) and
   * advanced cases that need full control of the fetcher. Most callers
   * should leave it unset.
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
   * SPARQL CONSTRUCT queries can produce duplicate triples – for example,
   * constant triples (like `?dataset a edm:ProvidedCHO`) are emitted for
   * every solution row. When enabled, a streaming identity filter removes
   * duplicates inline without buffering.
   *
   * The dedup set is scoped to each {@link read} call, so memory stays
   * bounded to the number of unique quads per call (typically one batch).
   *
   * Inspired by Comunica's `distinctConstruct` context option.
   *
   * @default false
   */
  deduplicate?: boolean;
}

/**
 * A streaming SPARQL CONSTRUCT reader.
 *
 * Each query runs on the {@link ReadOptions.limiter}, keyed on the endpoint
 * ({@link endpointKeyOf}). While the endpoint is down or struggling (408, 425,
 * 429, 502, 503, 504 or a network error) the reader pauses it and tries
 * again; on a 500 it splits the batch, down to a root it reports through {@link ReadOptions.onRootSkipped} and
 * leaves out. See
 * {@link https://ldelements.org/reference/pipeline#when-the-endpoint-fails | When the endpoint fails}.
 *
 * Queries **without** `#subjectFilter#` are parsed once in the constructor
 * (fast path). Queries that contain the template are stored as raw strings
 * and parsed at {@link read} time after substitution.
 *
 * Template substitution (applied in order):
 * 1. `#subjectFilter#` – replaced with `distribution.subjectFilter` (deferred to read)
 * 2. `FROM <graph>` – set via `withDefaultGraph` if the distribution has a named graph
 * 3. `?dataset` – replaced with the dataset IRI (string substitution on the serialised query)
 *
 * @example
 * ```typescript
 * const reader = new SparqlConstructReader({
 *   query: 'CONSTRUCT { ?dataset ?p ?o } WHERE { ?s ?p ?o }',
 * });
 * const result = await reader.read(dataset, distribution);
 * if (result instanceof NotSupported) {
 *   console.log(result.message);
 * } else {
 *   for await (const quad of result) {
 *     console.log(quad);
 *   }
 * }
 * ```
 */
export class SparqlConstructReader implements Reader {
  private readonly rawQuery: string;
  private readonly preParsed?: QueryConstruct;
  private readonly userFetcher?: SparqlEndpointFetcher;
  private readonly lineBuffer: boolean;
  private readonly deduplicate: boolean;
  private readonly generator = new Generator();

  constructor(options: SparqlConstructReaderOptions) {
    this.rawQuery = options.query;
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
  }

  /**
   * Read quads by executing the SPARQL CONSTRUCT query against the
   * distribution's endpoint.
   *
   * @param dataset The dataset to read from.
   * @param distribution The distribution providing the SPARQL endpoint.
   * @param options Optional read options (bindings).
   * @returns AsyncIterable<Quad> stream of results.
   */
  async read(
    dataset: Dataset,
    distribution: Distribution,
    options?: ReadOptions,
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

    assertSafeIri(dataset.iri.toString());
    const query = (bindings: VariableBindings[]) =>
      this.generator
        .generate(bindings.length > 0 ? injectValues(ast, bindings) : ast)
        .replaceAll('?dataset', `<${dataset.iri}>`);

    const bindings = options?.bindings ?? [];
    let skipped = 0;
    const quads = await this.readBatch(bindings, query, {
      endpoint,
      key: endpointKeyOf(endpoint),
      limiter: options?.limiter ?? createHostLimiter(10, 10),
      policy: options?.timeout ?? defaultTimeoutPolicy,
      onRootSkipped: (root, error) => {
        skipped++;
        options?.onRootSkipped?.(root, error);
        // Not one root answered: the endpoint fails this query whatever the
        // roots, so the batch fails rather than coming out empty.
        if (skipped === bindings.length && skipped > 1) throw error;
      },
    });

    return this.deduplicate ? deduplicateQuads(quads) : quads;
  }

  /**
   * Read one batch, splitting it on an HTTP 500 until the endpoint answers or
   * one root is left; see {@link SparqlConstructReader}.
   */
  private async readBatch(
    bindings: VariableBindings[],
    query: (bindings: VariableBindings[]) => string,
    attempt: Attempt,
  ): Promise<AsyncIterable<Quad>> {
    try {
      return await this.fetchWithRetries(query(bindings), attempt);
    } catch (error) {
      if (
        !(error instanceof Error) ||
        statusOf(error) !== 500 ||
        bindings.length === 0
      ) {
        throw error;
      }
      if (bindings.length === 1) {
        attempt.onRootSkipped(bindings[0], error);
        return noQuads();
      }
      const middle = Math.ceil(bindings.length / 2);
      const halves = [bindings.slice(0, middle), bindings.slice(middle)];
      // Each half is asked for once the one before it has been read, so a
      // split adds no load, and leaves no response open, of its own.
      const readHalf = (half: VariableBindings[]) =>
        this.readBatch(half, query, attempt);
      return (async function* () {
        for (const half of halves) {
          yield* await readHalf(half);
        }
      })();
    }
  }

  /**
   * Run a query on the limiter, pausing the endpoint and trying again while it is
   * down; see {@link SparqlConstructReader}.
   */
  private async fetchWithRetries(
    query: string,
    attempt: Attempt,
  ): Promise<AsyncIterable<Quad>> {
    for (let retry = 0; ; retry++) {
      try {
        return await attempt.limiter.run(attempt.key, async (slot) => {
          const response: ResponseNotes = {};
          try {
            return await this.fetchQuadsWithPolicy(
              attempt.endpoint,
              query,
              attempt.policy,
              response,
            );
          } catch (error) {
            // A rejection lowers the limit, unless the slot is told otherwise.
            if (isTransientError(error)) {
              // Paused before the slot frees, so no query waiting for it goes
              // out to an endpoint that is down.
              if (retry < BACKOFF_MS.length) {
                attempt.limiter.pause(
                  attempt.key,
                  Date.now() + backoffMs(retry, response.retryAfterMs),
                );
              }
            } else if (classifyOutcome(error) !== 'timeout') {
              slot.ignore();
            }
            throw error;
          }
        });
      } catch (error) {
        if (!isTransientError(error) || retry === BACKOFF_MS.length) {
          throw error;
        }
      }
    }
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
    response: ResponseNotes,
  ): Promise<AsyncIterable<Quad>> {
    const timeoutMs = policy.beforeRequest({ endpoint: endpointUrl });
    const fetcher = this.fetcherForAttempt(timeoutMs, response);
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
   * Pick the fetcher to use for a single attempt. A user-supplied fetcher
   * is used as-is and its own timeout governs the request; the per-attempt
   * policy budget is bypassed in that case (see the JSDoc on
   * {@link SparqlConstructReaderOptions.fetcher}). Otherwise a fresh
   * {@link SparqlEndpointFetcher} is constructed per attempt with the
   * policy-supplied timeout baked in, which notes the response’s
   * `Retry-After` in `response`.
   */
  private fetcherForAttempt(
    timeoutMs: number,
    response: ResponseNotes,
  ): SparqlEndpointFetcher {
    if (this.userFetcher) return this.userFetcher;
    return new SparqlEndpointFetcher({
      timeout: timeoutMs,
      fetch: async (input, init) => {
        const answer = await fetch(input, init);
        if (!answer.ok) {
          response.retryAfterMs = parseRetryAfter(
            answer.headers.get('retry-after'),
          );
        }
        return answer;
      },
    });
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
   * Create a reader from a query file.
   *
   * @param filename Path to the query file.
   * @param options Optional reader options (timeout, fetcher).
   */
  public static async fromFile(
    filename: string,
    options?: Omit<SparqlConstructReaderOptions, 'query'>,
  ): Promise<SparqlConstructReader> {
    const query = await readQueryFile(filename);
    return new SparqlConstructReader({ ...options, query });
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
 * tokens that straddle chunk boundaries – most commonly language tags like
 * `@nl-nl` – cause spurious `Unexpected "-nl"` parse errors. The error is
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

/** Where and how one batch’s queries run. */
interface Attempt {
  endpoint: URL;
  key: string;
  limiter: HostLimiter;
  policy: TimeoutPolicy;
  onRootSkipped: NonNullable<ReadOptions['onRootSkipped']>;
}

/** What a query’s response said beyond its status. */
interface ResponseNotes {
  retryAfterMs?: number;
}

async function* noQuads(): AsyncIterable<Quad> {
  // A skipped root reads as no quads.
}

/**
 * How long a reader pauses the endpoint before each retry after it
 * went down, in milliseconds: tripled each time, about 10 minutes in all, to
 * outlast a backend restart. A `Retry-After` header replaces a step.
 */
const BACKOFF_MS = [5_000, 15_000, 45_000, 135_000, 405_000];

/**
 * How long to pause before retry `retry`: what `Retry-After` asked, up to the
 * longest step, or the step itself when the endpoint did not say.
 */
function backoffMs(retry: number, retryAfterMs: number | undefined): number {
  return retryAfterMs === undefined
    ? BACKOFF_MS[retry]
    : Math.min(retryAfterMs, BACKOFF_MS[BACKOFF_MS.length - 1]);
}
