import { compressionMediaTypes, Distribution } from '@lde/dataset';
import { rdfParser } from 'rdf-parse';
import { Readable } from 'node:stream';
import { createGunzip } from 'node:zlib';

/**
 * Options for {@link probe}.
 */
export interface ProbeOptions {
  /** Request timeout in milliseconds. Defaults to 5 000. */
  timeoutMs?: number;
  /**
   * Extra HTTP headers to send with the request. Merged with probe-generated
   * headers; caller-supplied values take precedence on conflict.
   */
  headers?: Headers;
  /**
   * SPARQL query to use when probing a SPARQL endpoint. The query’s type
   * (`ASK` / `SELECT` / `CONSTRUCT` / `DESCRIBE`) determines the `Accept`
   * header and the response validation strategy. Ignored for data-dump
   * distributions. Defaults to `SELECT * { ?s ?p ?o } LIMIT 1`.
   */
  sparqlQuery?: string;
  /**
   * How many times to retry a connection-level failure (DNS, connection
   * refused, socket reset, TLS error, timeout) before returning a
   * {@link NetworkError}. Only transport errors are retried within the same
   * check, so a transient blip does not flip an otherwise healthy distribution
   * to ‘unavailable’; HTTP error responses and content-validation failures are
   * genuine ‘down’ states and are never retried. Set to `0` to disable.
   * Defaults to `2`. A non-integer or otherwise invalid value falls back to
   * the default; negative values are clamped to `0`.
   */
  retries?: number;
  /**
   * Validate the body content of data-dump distributions whose declared media
   * type is an RDF serialization, by reading a bounded prefix and confirming it
   * carries at least one triple. When `false` (the default) a data dump is only
   * checked for reachability (a `HEAD`, with a body-less `GET` fallback if `HEAD`
   * is unsupported) and its body is never read. When `true`, every declared-RDF
   * dump — regardless of size — is fetched and validated; non-RDF and
   * undeclared-type distributions are still reachability-only. Validation is
   * opt-in because reading a body forces a slow, generate-on-the-fly endpoint to
   * start producing its export, which a `HEAD` does not.
   */
  validateRdfContent?: boolean;
  /**
   * Soft deadline, in milliseconds, for finding the first triple when
   * {@link validateRdfContent} is on. Reachability is settled by the response
   * itself; if no triple has surfaced within this budget the read is aborted and
   * the distribution is reported reachable but unvalidated (no `failureReason`),
   * never failed. This bounds the extra latency content validation adds on slow,
   * generate-on-the-fly endpoints. Clamped to {@link timeoutMs} (a longer budget
   * is meaningless — the request times out first). Defaults to
   * `min(timeoutMs, 2000)`.
   */
  rdfValidationBudgetMs?: number;
}

/**
 * Options for {@link probeMany}: the per-probe {@link ProbeOptions} plus the
 * concurrency budgets that bound the batch.
 */
export interface ProbeManyOptions extends ProbeOptions {
  /**
   * Maximum number of probes to run at once across all hosts. Bounds the batch’s
   * total fan-out so a large catalogue does not exhaust sockets or buffer too many
   * response bodies at once. Default 20.
   */
  concurrency?: number;
  /**
   * Maximum number of probes to run at once against a single host. Bounds the
   * burst any one server sees, so a catalogue that declares many distributions on
   * one host (e.g. a download endpoint per named graph) does not trip its rate
   * limiter (HTTP 429). A probe whose host is at this cap waits while probes for
   * other hosts proceed, so this never idles the global pool. Default 4.
   */
  perHostConcurrency?: number;
  /**
   * Called once after each probe settles, with the number of probes completed so
   * far and the total to run (`distributions.length`). Lets a caller drive a
   * determinate progress indicator while a large batch runs. Fires `total` times,
   * ending at `(total, total)`; the order reflects completion, not input order.
   * Never called for an empty batch. A throwing callback rejects the batch, so
   * keep it cheap and side-effect-only.
   */
  onProgress?: (completed: number, total: number) => void;
}

const DEFAULT_SPARQL_QUERY = 'SELECT * { ?s ?p ?o } LIMIT 1';
const DEFAULT_TIMEOUT_MS = 5000;
const DEFAULT_RETRIES = 2;
const DEFAULT_PROBE_CONCURRENCY = 20;
const DEFAULT_PROBE_PER_HOST_CONCURRENCY = 4;

/**
 * Default soft deadline for finding the first triple when content validation is
 * on (capped at `timeoutMs`). Two seconds comfortably covers a static file
 * server's first chunk while keeping the extra wait bounded on a slow,
 * generate-on-the-fly endpoint.
 */
const DEFAULT_RDF_VALIDATION_BUDGET_MS = 2000;

/** Sentinel: the validation budget elapsed before a triple surfaced. */
const VALIDATION_TIMED_OUT = Symbol('rdf-validation-timed-out');

/**
 * Maximum number of body bytes the data-dump probe reads before it stops and
 * releases the connection. Reachability needs only that the endpoint answered
 * with a success status and produced bytes; a large dump must never be
 * downloaded in full within the probe's timeout budget. 256 KiB comfortably
 * surfaces the first RDF triple — the signal {@link validateBody} needs — while
 * bounding the read regardless of the dump's true size, chunked transfer, or
 * compression. Applied to both the raw read and, for a gzip body, the inflated
 * output.
 */
const MAX_PROBE_BODY_BYTES = 256 * 1024;

/** Base backoff between retries; the nth retry waits `n × base`. */
const RETRY_BACKOFF_MS = 250;

/**
 * Result of a network error during probing.
 */
export class NetworkError {
  constructor(
    public readonly url: string,
    public readonly message: string,
    public readonly responseTimeMs: number,
  ) {}
}

/**
 * Base class for successful probe results.
 */
abstract class ProbeResult {
  public readonly statusCode: number;
  public readonly statusText: string;
  public readonly lastModified: Date | null = null;
  public readonly contentType: string | null;
  public readonly failureReason: string | null;
  public readonly warnings: string[] = [];
  public readonly responseTimeMs: number;

  constructor(
    public readonly url: string,
    response: Response,
    responseTimeMs: number,
    failureReason: string | null = null,
  ) {
    this.statusCode = response.status;
    this.statusText = response.statusText;
    this.contentType = response.headers.get('Content-Type');
    this.failureReason = failureReason;
    this.responseTimeMs = responseTimeMs;
    const lastModifiedHeader = response.headers.get('Last-Modified');
    if (lastModifiedHeader) {
      this.lastModified = new Date(lastModifiedHeader);
    }
  }

  public isSuccess(): boolean {
    return (
      this.statusCode >= 200 &&
      this.statusCode < 400 &&
      this.failureReason === null
    );
  }
}

const SPARQL_RESULTS_JSON = 'application/sparql-results+json';
const SPARQL_RESULTS_XML = 'application/sparql-results+xml';

/**
 * RDF serializations a CONSTRUCT or DESCRIBE query may be answered with, in
 * preference order. The endpoint chooses the serialization, so availability must
 * not hinge on a single one: accepting only n-triples flagged healthy endpoints
 * that answer in Turtle (a common default) as unavailable, and made endpoints
 * that cannot emit n-triples reject the probe with HTTP 406.
 */
const SPARQL_RDF_RESULTS = [
  'text/turtle',
  'application/n-triples',
  'application/rdf+xml',
  'application/ld+json',
  'application/n-quads',
  'application/trig',
];

/**
 * Result of probing a SPARQL endpoint.
 */
export class SparqlProbeResult extends ProbeResult {
  /**
   * Content types the probe was prepared to accept as a valid answer. A SELECT or
   * ASK query may be answered with SPARQL results in JSON or XML; the endpoint
   * chooses, so success is not tied to a single serialization. A single string is
   * accepted and normalized to a one-element list for backwards compatibility.
   */
  public readonly acceptedContentTypes: readonly string[];

  constructor(
    url: string,
    response: Response,
    responseTimeMs: number,
    acceptedContentTypes: string | readonly string[],
    failureReason: string | null = null,
  ) {
    super(url, response, responseTimeMs, failureReason);
    this.acceptedContentTypes =
      typeof acceptedContentTypes === 'string'
        ? [acceptedContentTypes]
        : acceptedContentTypes;
  }

  override isSuccess(): boolean {
    return (
      super.isSuccess() &&
      this.acceptedContentTypes.some(
        (type) => this.contentType?.startsWith(type) ?? false,
      )
    );
  }
}

/**
 * Result of probing a data dump distribution.
 */
export class DataDumpProbeResult extends ProbeResult {
  public readonly contentSize: number | null = null;

  constructor(
    url: string,
    response: Response,
    responseTimeMs: number,
    failureReason: string | null = null,
  ) {
    super(url, response, responseTimeMs, failureReason);
    const contentLengthHeader = response.headers.get('Content-Length');
    if (contentLengthHeader) {
      this.contentSize = parseInt(contentLengthHeader);
    }
  }
}

export type ProbeResultType =
  | SparqlProbeResult
  | DataDumpProbeResult
  | NetworkError;

type SparqlQueryType = 'ASK' | 'SELECT' | 'CONSTRUCT' | 'DESCRIBE';

/**
 * Probe a distribution to check availability and gather metadata.
 *
 * For SPARQL endpoints, issues the configured SPARQL query (default: a
 * minimal `SELECT`). For data dumps, issues `HEAD` (with a `GET` fallback
 * for small or unknown-size bodies, reading only a bounded prefix so a large
 * streamed dump is never downloaded in full).
 *
 * Returns a pure result object; never throws.
 */
export async function probe(
  distribution: Distribution,
  options?: ProbeOptions,
): Promise<ProbeResultType> {
  const resolved = resolveOptions(options);
  const url = distribution.accessUrl?.toString() ?? 'unknown';
  const [authUrl, authHeaders] =
    distribution.accessUrl !== undefined
      ? extractUrlCredentials(distribution.accessUrl, resolved.headers)
      : [new URL(url), new Headers(resolved.headers)];

  // Retry only connection-level failures (a thrown `fetch`): HTTP error
  // responses and content-validation failures are returned as result objects,
  // never thrown, so they exit the loop on the first attempt and are not
  // retried. A genuine outage still resolves to a NetworkError – every attempt
  // fails – but note each attempt gets its own `timeoutMs`, so an endpoint that
  // fails only by timing out takes up to (retries + 1) × timeoutMs (plus
  // backoff) to be reported down.
  const overallStart = performance.now();
  let lastError: unknown;
  for (let attempt = 0; attempt <= resolved.retries; attempt++) {
    if (attempt > 0) {
      await delay(RETRY_BACKOFF_MS * attempt);
    }
    const start = performance.now();
    try {
      if (distribution.isSparql()) {
        return await probeSparqlEndpoint(
          authUrl.toString(),
          distribution,
          resolved,
          authHeaders,
          start,
        );
      }
      return await probeDataDump(
        authUrl.toString(),
        distribution,
        resolved,
        authHeaders,
        start,
      );
    } catch (error) {
      lastError = error;
    }
  }

  // A successful probe reports its own attempt's latency (computed inside the
  // probe functions); a NetworkError reports the total time spent failing,
  // across every attempt and backoff, so observations do not understate the
  // real cost of a down endpoint.
  return new NetworkError(
    url,
    describeNetworkError(lastError),
    Math.round(performance.now() - overallStart),
  );
}

/**
 * Probe many distributions concurrently, bounded by a global cap and a per-host
 * cap, returning one result per input in input order. Like {@link probe}, this
 * never throws: a probe that somehow fails is reported as a {@link NetworkError}
 * in its slot.
 *
 * The per-host cap keeps the batch a polite client. Distributions sharing a host
 * (by {@link Distribution.accessUrl}) contend for the same budget, so no single
 * server is hit by the full global pool at once — the burst that trips a rate
 * limiter (HTTP 429). When the next queued probe’s host is saturated it is
 * skipped in favour of a later probe on a different host, so one busy host never
 * idles the global pool (no head-of-line blocking).
 */
export async function probeMany(
  distributions: readonly Distribution[],
  options?: ProbeManyOptions,
): Promise<ProbeResultType[]> {
  // Clamp the budgets to a positive integer, mirroring how probe() treats an
  // invalid retries value: a zero, negative, fractional, or NaN limit would
  // otherwise stall the scheduler (no task ever starts, so the promise never
  // resolves) or overrun the cap, so fall back to the default rather than trust
  // the caller.
  const globalLimit = positiveIntOrDefault(
    options?.concurrency,
    DEFAULT_PROBE_CONCURRENCY,
  );
  const perHostLimit = positiveIntOrDefault(
    options?.perHostConcurrency,
    DEFAULT_PROBE_PER_HOST_CONCURRENCY,
  );
  // Probes contend per host. An authority-less URL (e.g. urn:, file:) has an
  // empty host, so it falls back to its full href and never shares a budget with
  // an unrelated one.
  const hostKeys = distributions.map(
    (distribution) =>
      distribution.accessUrl.host || distribution.accessUrl.href,
  );
  // Report progress as each probe settles. mapHostLimited resolves results in
  // input order, but tasks complete out of order, so count completions here
  // rather than rely on result position. The total is the batch size.
  const onProgress = options?.onProgress;
  const total = distributions.length;
  let completed = 0;
  return mapHostLimited(
    distributions,
    hostKeys,
    globalLimit,
    perHostLimit,
    async (distribution) => {
      const result = await probe(distribution, options);
      completed += 1;
      onProgress?.(completed, total);
      return result;
    },
  );
}

/**
 * Coerce an optional concurrency budget to a usable value: a positive integer is
 * taken as-is; undefined, zero, negative, fractional, or NaN falls back to the
 * default. Matches probe()’s treatment of an invalid retries value.
 */
function positiveIntOrDefault(
  value: number | undefined,
  fallback: number,
): number {
  return value !== undefined && Number.isInteger(value) && value >= 1
    ? value
    : fallback;
}

/**
 * Run `task` over `items` with two concurrency caps — a global cap and a per-host
 * cap keyed by `hostKeys[index]` — resolving to results in input order. When the
 * next queued item’s host is at the per-host cap it is skipped for a later item on
 * a different host, so a saturated host never idles the global pool (no head-of-line
 * blocking); the skipped host always has a task in flight, whose completion re-runs
 * the scheduler, so the queue always drains. `task` must not reject — callers wrap
 * failures into a result value — as a rejection would leave the promise pending.
 */
function mapHostLimited<TItem, TResult>(
  items: readonly TItem[],
  hostKeys: readonly string[],
  globalLimit: number,
  perHostLimit: number,
  task: (item: TItem) => Promise<TResult>,
): Promise<TResult[]> {
  const results: TResult[] = new Array(items.length);
  const perHostInFlight = new Map<string, number>();
  const pending = items.map((_unused, index) => index);
  let globalInFlight = 0;
  let settledCount = 0;

  const adjustHost = (host: string, delta: number): void => {
    perHostInFlight.set(host, (perHostInFlight.get(host) ?? 0) + delta);
  };

  return new Promise((resolve) => {
    const schedule = (): void => {
      let cursor = 0;
      while (cursor < pending.length && globalInFlight < globalLimit) {
        const index = pending[cursor];
        const host = hostKeys[index];
        if ((perHostInFlight.get(host) ?? 0) >= perHostLimit) {
          cursor++; // Host saturated; leave it queued and try a later, different host.
          continue;
        }
        pending.splice(cursor, 1);
        globalInFlight++;
        adjustHost(host, 1);
        void task(items[index]).then((result) => {
          results[index] = result;
          globalInFlight--;
          adjustHost(host, -1);
          settledCount++;
          if (settledCount === items.length) {
            resolve(results);
          } else {
            schedule();
          }
        });
        // pending[cursor] now holds the next queued item; do not advance cursor.
      }
    };
    schedule();
    // Resolve immediately when there is nothing to settle (empty input); a
    // non-empty run resolves via the task completion above.
    if (settledCount === items.length) resolve(results);
  });
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

/**
 * Describe a thrown fetch error for a {@link NetworkError} message. undici wraps
 * * the real reason (`ECONNRESET`, `UND_ERR_SOCKET “other side closed”`, TLS
 * errors, …) in `error.cause`, while `error.message` is usually a bare
 * ‘fetch failed’. Including the cause’s code and message preserves the
 * diagnostic detail that would otherwise be discarded.
 */
function describeNetworkError(error: unknown): string {
  if (!(error instanceof Error)) {
    return String(error);
  }
  const { cause } = error;
  if (cause === undefined || cause === null) {
    return error.message;
  }
  const detail =
    cause instanceof Error
      ? [(cause as NodeJS.ErrnoException).code, cause.message]
          .filter(Boolean)
          .join(': ')
      : String(cause);
  return detail && detail !== error.message
    ? `${error.message} (${detail})`
    : error.message;
}

function resolveOptions(
  options: ProbeOptions | undefined,
): Required<ProbeOptions> {
  const retries = options?.retries;
  return {
    timeoutMs: options?.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    headers: options?.headers ?? new Headers(),
    sparqlQuery: options?.sparqlQuery ?? DEFAULT_SPARQL_QUERY,
    // Guard the loop bound: a non-integer (NaN, Infinity, fractional) would
    // otherwise either skip the loop entirely or never terminate. Negatives
    // clamp to 0 (retries disabled).
    retries:
      retries === undefined || !Number.isInteger(retries)
        ? DEFAULT_RETRIES
        : Math.max(0, retries),
    validateRdfContent: options?.validateRdfContent ?? false,
    rdfValidationBudgetMs:
      options?.rdfValidationBudgetMs ??
      Math.min(
        options?.timeoutMs ?? DEFAULT_TIMEOUT_MS,
        DEFAULT_RDF_VALIDATION_BUDGET_MS,
      ),
  };
}

/**
 * Strip `user:pass@` from a URL and turn it into an `Authorization: Basic`
 * header. Returns the cleaned URL and a merged Headers object that preserves
 * any caller-supplied headers.
 */
function extractUrlCredentials(url: URL, baseHeaders: Headers): [URL, Headers] {
  const headers = new Headers(baseHeaders);
  if (url.username === '' && url.password === '') {
    return [url, headers];
  }
  const credentials = `${decodeURIComponent(url.username)}:${decodeURIComponent(
    url.password,
  )}`;
  if (!headers.has('Authorization')) {
    headers.set(
      'Authorization',
      `Basic ${Buffer.from(credentials).toString('base64')}`,
    );
  }
  const cleanUrl = new URL(url.toString());
  cleanUrl.username = '';
  cleanUrl.password = '';
  return [cleanUrl, headers];
}

/**
 * Classify a SPARQL query. Comments are stripped; the first keyword match
 * wins. Falls back to `SELECT` when no keyword is found – robust enough for
 * availability probing but not a full SPARQL parser.
 */
function detectSparqlQueryType(query: string): SparqlQueryType {
  const withoutComments = query.replace(/#[^\n\r]*/g, ' ');
  const match = /\b(ASK|SELECT|CONSTRUCT|DESCRIBE)\b/i.exec(withoutComments);
  return (match?.[1].toUpperCase() ?? 'SELECT') as SparqlQueryType;
}

/**
 * Content types a SPARQL endpoint may legitimately answer with, in preference
 * order, for the given query type. SELECT and ASK return a results document
 * (JSON or XML – the endpoint chooses); CONSTRUCT and DESCRIBE return RDF.
 */
function acceptableContentTypes(queryType: SparqlQueryType): string[] {
  if (queryType === 'ASK' || queryType === 'SELECT') {
    return [SPARQL_RESULTS_JSON, SPARQL_RESULTS_XML];
  }
  return [...SPARQL_RDF_RESULTS];
}

/**
 * Build an `Accept` header that prefers the first content type but still accepts
 * the rest at a lower q-value, so an endpoint that only serves a later type is
 * not rejected with a 406.
 */
function acceptHeader(contentTypes: readonly string[]): string {
  return contentTypes
    .map((type, index) => (index === 0 ? type : `${type};q=0.9`))
    .join(', ');
}

async function probeSparqlEndpoint(
  url: string,
  _distribution: Distribution,
  options: Required<ProbeOptions>,
  authHeaders: Headers,
  start: number,
): Promise<SparqlProbeResult | NetworkError> {
  const queryType = detectSparqlQueryType(options.sparqlQuery);
  const acceptedContentTypes = acceptableContentTypes(queryType);
  const headers = new Headers({
    'Content-Type': 'application/x-www-form-urlencoded;charset=UTF-8',
    Accept: acceptHeader(acceptedContentTypes),
  });
  for (const [key, value] of authHeaders) {
    headers.set(key, value);
  }

  const response = await fetch(url, {
    signal: AbortSignal.timeout(options.timeoutMs),
    method: 'POST',
    headers,
    body: `query=${encodeURIComponent(options.sparqlQuery)}`,
  });

  const actualContentType = response.headers.get('Content-Type');
  const matchedContentType = acceptedContentTypes.find(
    (type) => actualContentType?.startsWith(type) ?? false,
  );
  let failureReason: string | null = null;
  if (response.ok && matchedContentType !== undefined) {
    failureReason = await validateSparqlResponse(
      response,
      queryType,
      matchedContentType,
    );
  } else {
    // Drain unconsumed body to release the underlying connection.
    await response.body?.cancel();
  }

  const responseTimeMs = Math.round(performance.now() - start);
  return new SparqlProbeResult(
    url,
    response,
    responseTimeMs,
    acceptedContentTypes,
    failureReason,
  );
}

async function validateSparqlResponse(
  response: Response,
  queryType: SparqlQueryType,
  contentType: string,
): Promise<string | null> {
  if (queryType === 'CONSTRUCT' || queryType === 'DESCRIBE') {
    // A CONSTRUCT/DESCRIBE answer is RDF, and an empty graph is a valid answer –
    // e.g. an availability probe whose query happens to match nothing – so the
    // 200 response alone confirms the endpoint is up. Deep parse validation is
    // the data-dump path’s job. Only data dumps must be non-empty (see
    // validateBody); a SPARQL result may be empty.
    await response.body?.cancel();
    return null;
  }

  const body = await response.text();
  if (body.length === 0) {
    return 'SPARQL endpoint returned an empty response';
  }

  return contentType.startsWith(SPARQL_RESULTS_XML)
    ? validateSparqlXmlResults(body, queryType)
    : validateSparqlJsonResults(body, queryType);
}

function validateSparqlJsonResults(
  body: string,
  queryType: SparqlQueryType,
): string | null {
  let json: Record<string, unknown>;
  try {
    json = JSON.parse(body) as Record<string, unknown>;
  } catch {
    return 'SPARQL endpoint returned invalid JSON';
  }

  if (queryType === 'ASK') {
    if (typeof json.boolean !== 'boolean') {
      return 'SPARQL endpoint did not return a valid ASK result';
    }
    return null;
  }

  // SELECT
  if (!json.results || typeof json.results !== 'object') {
    return 'SPARQL endpoint did not return a valid results object';
  }
  return null;
}

/**
 * Lightweight structural check on a SPARQL Query Results XML document. Mirrors
 * the JSON path’s intent – confirm the endpoint answered with the expected shape
 * – without pulling in a full XML parser.
 */
function validateSparqlXmlResults(
  body: string,
  queryType: SparqlQueryType,
): string | null {
  if (!/<sparql[\s>]/i.test(body)) {
    return 'SPARQL endpoint returned invalid XML';
  }

  if (queryType === 'ASK') {
    if (!/<boolean>\s*(true|false)\s*<\/boolean>/i.test(body)) {
      return 'SPARQL endpoint did not return a valid ASK result';
    }
    return null;
  }

  // SELECT
  if (!/<results[\s/>]/i.test(body)) {
    return 'SPARQL endpoint did not return a valid results object';
  }
  return null;
}

async function probeDataDump(
  url: string,
  distribution: Distribution,
  options: Required<ProbeOptions>,
  authHeaders: Headers,
  start: number,
): Promise<DataDumpProbeResult | NetworkError> {
  // Express a preference for the declared media type, but accept anything as a
  // fallback. Servers that implement RFC 9110 §12.5.1 content negotiation will
  // pick the declared type (preserving our ability to detect real Content-Type
  // mismatches). Servers that reject any non-*/* Accept with 406 — notably
  // Dataverse's /api/access/datafile/ endpoint (IQSS/dataverse#12410) — fall
  // back to */* and return the file unchanged.
  const headers = new Headers({
    Accept: distribution.mimeType
      ? `${distribution.mimeType}, */*;q=0.5`
      : '*/*',
    'Accept-Encoding': 'identity',
  });
  for (const [key, value] of authHeaders) {
    headers.set(key, value);
  }

  const requestOptions = {
    signal: AbortSignal.timeout(options.timeoutMs),
    headers,
  };

  const headResponse = await fetch(url, {
    method: 'HEAD',
    ...requestOptions,
  });

  // Validate body content only when asked to and the distribution declares an
  // RDF media type; otherwise the probe is reachability-only and never reads a
  // body — which keeps it from forcing a slow, generate-on-the-fly endpoint to
  // start producing its export.
  if (
    options.validateRdfContent &&
    isDeclaredRdf(distribution) &&
    isHttpSuccess(headResponse)
  ) {
    const { response, failureReason } = await validateDumpBody(
      url,
      headers,
      options,
      headResponse,
    );
    return finalizeDataDump(url, distribution, response, start, failureReason);
  }

  // Reachability only. A successful HEAD is enough; otherwise confirm with a
  // body-less GET, which rescues servers that reject or do not implement HEAD.
  if (isHttpSuccess(headResponse)) {
    return finalizeDataDump(url, distribution, headResponse, start, null);
  }
  const getResponse = await fetch(url, { method: 'GET', ...requestOptions });
  await getResponse.body?.cancel();
  return finalizeDataDump(url, distribution, getResponse, start, null);
}

/** Whether an HTTP response carries a success (2xx/3xx) status. */
function isHttpSuccess(response: Response): boolean {
  return response.status >= 200 && response.status < 400;
}

/** Whether the distribution declares an RDF serialization as its media type. */
function isDeclaredRdf(distribution: Distribution): boolean {
  const declared = distribution.mimeType?.toLowerCase();
  return declared !== undefined && rdfContentTypes.includes(declared);
}

/** Build a DataDumpProbeResult and attach any Content-Type-mismatch warning. */
function finalizeDataDump(
  url: string,
  distribution: Distribution,
  response: Response,
  start: number,
  failureReason: string | null,
): DataDumpProbeResult {
  const responseTimeMs = Math.round(performance.now() - start);
  const result = new DataDumpProbeResult(
    url,
    response,
    responseTimeMs,
    failureReason,
  );
  checkContentTypeMismatch(result, distribution);
  return result;
}

/**
 * GET the dump and validate that its body carries a triple, but only for as long
 * as the validation budget allows. Reachability is already settled by the prior
 * HEAD, so any shortfall — a budget that elapses before a triple, a read error,
 * a GET that cannot start — yields a `null` failureReason (reachable,
 * unvalidated), never a failure. Returns the response to draw metadata from
 * (the GET, or the HEAD when the GET could not start) alongside that reason.
 */
async function validateDumpBody(
  url: string,
  headers: Headers,
  options: Required<ProbeOptions>,
  headResponse: Response,
): Promise<{ response: Response; failureReason: string | null }> {
  const budgetMs = Math.min(options.rdfValidationBudgetMs, options.timeoutMs);
  // Aborting on budget expiry stops a slow endpoint from streaming on in the
  // background once we have given up waiting for a triple.
  const budgetController = new AbortController();
  let getResponse: Response;
  try {
    getResponse = await fetch(url, {
      method: 'GET',
      headers,
      signal: AbortSignal.any([
        AbortSignal.timeout(options.timeoutMs),
        budgetController.signal,
      ]),
    });
  } catch {
    // The GET could not even return headers; the HEAD already proved the
    // distribution reachable, so report it unvalidated rather than down.
    return { response: headResponse, failureReason: null };
  }
  if (!isHttpSuccess(getResponse)) {
    await getResponse.body?.cancel();
    return { response: getResponse, failureReason: null };
  }

  const validation: Promise<string | null> = (async () => {
    const bounded = await readBoundedBody(getResponse, MAX_PROBE_BODY_BYTES);
    const { text, truncated, corrupt } = await decodeProbeBody(bounded);
    return corrupt
      ? 'Distribution is not valid gzip'
      : await validateBody(
          text,
          getResponse.headers.get('Content-Type'),
          url,
          budgetController.signal,
          truncated,
        );
  })().catch(() => null);

  let budgetTimer: ReturnType<typeof setTimeout> | undefined;
  const budgetExpiry = new Promise<typeof VALIDATION_TIMED_OUT>((resolve) => {
    budgetTimer = setTimeout(() => {
      budgetController.abort();
      resolve(VALIDATION_TIMED_OUT);
    }, budgetMs);
  });
  try {
    const outcome = await Promise.race([validation, budgetExpiry]);
    return {
      response: getResponse,
      failureReason: outcome === VALIDATION_TIMED_OUT ? null : outcome,
    };
  } finally {
    clearTimeout(budgetTimer);
  }
}

/**
 * Read at most `maxBytes` from a response body, then cancel the stream to free
 * the underlying connection. Returns the bytes read and whether the body was
 * longer than the cap (`truncated`), so the caller can tell a complete, small
 * body — whose emptiness or parse errors are meaningful — from a deliberately
 * cut-off prefix of a large one, where only the presence of content is
 * conclusive. This is what keeps the probe from downloading a multi-hundred-MB
 * streamed dump in full just to confirm it is reachable.
 */
async function readBoundedBody(
  response: Response,
  maxBytes: number,
): Promise<{ bytes: Uint8Array; truncated: boolean }> {
  const stream = response.body;
  if (stream === null) {
    return { bytes: new Uint8Array(0), truncated: false };
  }
  const chunks: Uint8Array[] = [];
  let total = 0;
  let truncated = false;
  // Breaking out of `for await` cancels the stream, which stops any further
  // download and releases the underlying connection — so a large dump is never
  // pulled in full once we have the prefix we need.
  for await (const chunk of stream as AsyncIterable<Uint8Array>) {
    chunks.push(chunk);
    total += chunk.length;
    if (total >= maxBytes) {
      truncated = true;
      break;
    }
  }
  return { bytes: Buffer.concat(chunks), truncated };
}

/**
 * Decode a bounded body to text for RDF validation, inflating it first when it
 * is a gzip stream that `fetch` did not transparently decompress — e.g. a `.gz`
 * data dump served as-is, or one labelled with a non-standard Content-Encoding
 * (`application/gzip`) that undici does not recognise as a content coding.
 * Detection is by the gzip magic on the delivered bytes, so a body that `fetch`
 * already inflated (a standard `Content-Encoding: gzip`) is passed through
 * untouched. A truncated gzip tail is expected — we only read a prefix — and
 * inflates cleanly up to the cut, so it is never mistaken for corruption.
 */
async function decodeProbeBody(bounded: {
  bytes: Uint8Array;
  truncated: boolean;
}): Promise<{ text: string; truncated: boolean; corrupt: boolean }> {
  if (!isGzip(bounded.bytes)) {
    return {
      text: decodeUtf8(bounded.bytes),
      truncated: bounded.truncated,
      corrupt: false,
    };
  }
  // The compressed body is complete only when the raw read was not itself cut
  // off: a gzip error on a complete body is genuine corruption, on a prefix we
  // cut it is just the dropped tail.
  const inflated = await gunzipPrefix(
    bounded.bytes,
    MAX_PROBE_BODY_BYTES,
    !bounded.truncated,
  );
  return {
    text: decodeUtf8(inflated.bytes),
    truncated: bounded.truncated || inflated.truncated,
    corrupt: inflated.corrupt,
  };
}

/** Whether the bytes begin with the gzip magic number (RFC 1952 §2.3.1). */
function isGzip(bytes: Uint8Array): boolean {
  return bytes.length >= 2 && bytes[0] === 0x1f && bytes[1] === 0x8b;
}

/**
 * Decode bytes as UTF-8 without throwing: an incomplete multi-byte sequence at
 * the truncation boundary is replaced rather than fatal, since the RDF parser
 * only needs the leading, intact portion to find the first triple.
 */
function decodeUtf8(bytes: Uint8Array): string {
  return new TextDecoder('utf-8', { fatal: false }).decode(bytes);
}

/**
 * Inflate up to `maxBytes` of output from a gzip prefix, stopping once the cap
 * is reached or the input runs out. `inputComplete` says whether the caller
 * handed us the whole compressed body (true) or a prefix it had already cut
 * (false). An inflate error therefore means different things: on a complete body
 * the gzip is genuinely corrupt; on a cut prefix it is just the dropped tail, so
 * whatever inflated cleanly is reported as a (truncated) partial inflate.
 */
function gunzipPrefix(
  bytes: Uint8Array,
  maxBytes: number,
  inputComplete: boolean,
): Promise<{ bytes: Uint8Array; truncated: boolean; corrupt: boolean }> {
  return new Promise((resolve) => {
    const gunzip = createGunzip();
    const chunks: Uint8Array[] = [];
    let total = 0;
    // `resolve` and `destroy` are both idempotent, so the first outcome wins and
    // any later event (e.g. a premature-close error emitted by `destroy`) is a
    // harmless no-op — no `settled` guard needed.
    function finish(outcome: { truncated: boolean; corrupt: boolean }): void {
      gunzip.destroy();
      resolve({ bytes: Buffer.concat(chunks), ...outcome });
    }
    gunzip.on('data', (chunk: Buffer) => {
      chunks.push(chunk);
      total += chunk.length;
      if (total >= maxBytes) {
        finish({ truncated: true, corrupt: false });
      }
    });
    gunzip.on('error', () =>
      finish({ truncated: !inputComplete, corrupt: inputComplete }),
    );
    gunzip.on('end', () => finish({ truncated: false, corrupt: false }));
    gunzip.end(bytes);
  });
}

// The RDF serializations whose bodies we parse to confirm they carry triples. A
// non-empty body in one of these formats that yields zero triples — an empty
// graph such as a JSON-LD `{}`, an `<rdf:RDF/>`, or prefix-only Turtle — is a
// faulty distribution, not a usable one, so it must be caught here. Other
// content types (CSV, HTML, …) are left untouched: the probe is not the place
// to assert what a non-RDF body should contain.
const rdfContentTypes = [
  'text/turtle',
  'application/n-triples',
  'application/n-quads',
  'application/trig',
  'text/n3',
  'application/ld+json',
  'application/rdf+xml',
];

// Serializations a streaming parser cannot validate from a truncated prefix.
// The line/statement-oriented formats (N-Triples, N-Quads, Turtle, TriG, N3) and
// SAX-based RDF/XML all yield their first triple from the opening chunk, but
// JSON-LD is a single JSON value whose parser emits nothing until the whole
// document closes — a truncated JSON-LD body parses to an ‘unclosed document’
// error, never a triple. So a truncated body in one of these can only be
// validated if it happened to fit the read cap in full; beyond that it is
// inconclusive, and we must not download it in full to find out.
const nonStreamableRdfContentTypes = ['application/ld+json'];

async function validateBody(
  body: string,
  contentType: string | null,
  baseIRI: string,
  budgetSignal: AbortSignal,
  truncated: boolean,
): Promise<string | null> {
  if (body.length === 0) {
    // A complete, empty body is a faulty distribution; an empty *prefix* (a
    // truncated read that yielded no bytes, e.g. a corrupt gzip header) is
    // inconclusive — the endpoint answered, we just could not validate content.
    return truncated ? null : 'Distribution is empty';
  }

  // Media types are case-insensitive (RFC 9110 §8.3.1), so normalise before
  // matching the lower-case allow-list — a server sending `Application/LD+JSON`
  // must still have its body validated.
  const serialization = contentType?.split(';')[0].trim().toLowerCase();
  if (!serialization || !rdfContentTypes.includes(serialization)) {
    return null;
  }

  if (truncated && nonStreamableRdfContentTypes.includes(serialization)) {
    // A bounded prefix of a non-streamable serialization (JSON-LD) can never
    // yield a triple, so skip the doomed parse and report it inconclusive — only
    // a complete document, small enough to fit the read cap, can be validated.
    return null;
  }

  const outcome = await classifyRdfBody(
    body,
    serialization,
    baseIRI,
    budgetSignal,
    truncated,
  );
  switch (outcome.type) {
    case 'empty':
      return 'Distribution contains no RDF triples';
    case 'parseError':
      return outcome.message;
    // 'hasTriples' proves content. 'inconclusive' means the parse timed out or a
    // remote JSON-LD @context could not be loaded — a third-party hiccup, not
    // evidence the distribution is faulty — so neither is reported as a failure.
    default:
      return null;
  }
}

type RdfBodyOutcome =
  | { type: 'hasTriples' }
  | { type: 'empty' }
  | { type: 'parseError'; message: string }
  | { type: 'inconclusive' };

/**
 * Parse an RDF body just far enough to tell whether it carries any triples:
 * resolve on the first triple (presence is all we need, not a full count), on a
 * clean end with none ('empty'), or on a parse error. The parse is bounded by
 * `budgetSignal` – the caller’s validation-budget {@link AbortController} –
 * because a JSON-LD `@context` is fetched from its origin, and a slow or hanging
 * context host would otherwise stall the probe past its budget; on abort – and
 * likewise when a remote `@context` is unreachable – the outcome is
 * 'inconclusive', so a valid distribution is never flagged faulty for a context
 * host’s failure. Sharing the caller’s single budget (rather than starting a
 * second, identical timer) keeps that timeout deterministic: it fires once, when
 * the budget elapses, instead of leaving an orphan timer to settle on its own
 * schedule. `baseIRI` resolves any relative IRIs in the document.
 *
 * When `truncated` is true the body is only a bounded prefix of a larger one, so
 * only finding a triple ('hasTriples') is conclusive: a parse error at the cut
 * or a clean end with no triple yet means we did not read far enough, not that
 * the distribution is empty or malformed, and is reported as 'inconclusive'.
 */
function classifyRdfBody(
  body: string,
  contentType: string,
  baseIRI: string,
  budgetSignal: AbortSignal,
  truncated: boolean,
): Promise<RdfBodyOutcome> {
  return new Promise<RdfBodyOutcome>((resolve) => {
    const quads = rdfParser.parse(Readable.from([body]), {
      contentType,
      baseIRI,
    });
    const onBudgetElapsed = (): void => settle({ type: 'inconclusive' });
    let settled = false;
    function settle(outcome: RdfBodyOutcome): void {
      if (settled) return;
      settled = true;
      budgetSignal.removeEventListener('abort', onBudgetElapsed);
      quads.destroy();
      resolve(outcome);
    }
    // Attach the parser listeners before consulting the budget: settle() calls
    // quads.destroy(), which can make the parser emit a late 'error', so the
    // error sink must already be in place – including on the already-aborted
    // path below – or that error goes unhandled and crashes the process.
    quads
      .on('data', () => settle({ type: 'hasTriples' }))
      .on('error', (error: Error) =>
        settle(
          truncated || isRemoteContextError(error)
            ? { type: 'inconclusive' }
            : { type: 'parseError', message: error.message },
        ),
      )
      .on('end', () =>
        settle(truncated ? { type: 'inconclusive' } : { type: 'empty' }),
      );
    // The budget may already have elapsed while the body was being read; an
    // already-aborted signal never emits another 'abort', so settle immediately
    // rather than wait for an event that will not come.
    if (budgetSignal.aborted) {
      onBudgetElapsed();
    } else {
      budgetSignal.addEventListener('abort', onBudgetElapsed, { once: true });
    }
  });
}

/**
 * Whether a parse error is the RDF parser failing to load a remote JSON-LD
 * `@context` (an unreachable or broken third-party context host) rather than a
 * defect in the distribution body itself.
 */
function isRemoteContextError(error: Error): boolean {
  return /remote context/i.test(error.message);
}

/**
 * Compare the declared media type from the dataset registry against the
 * server's Content-Type header. Adds a warning when they disagree.
 *
 * The declared compressed form (e.g. `application/n-quads+gzip`) is the expected
 * answer for a `+gzip`/`+zip` distribution, since the body is a gzip/zip archive
 * served as-is. The bare media type (`application/n-quads`) is also accepted as a
 * lenient fallback — the RDF serialization is the same and only the compression
 * wrapper is absent — so a server that serves the uncompressed representation is
 * not flagged. A different compression suffix or a different base serialization is
 * still a genuine mismatch. The registry strips the suffix into a separate compress
 * format on ingest, so comparing against {@link Distribution.mimeType} alone would
 * false-positive every compressed distribution.
 */
function checkContentTypeMismatch(
  result: DataDumpProbeResult,
  distribution: Distribution,
): void {
  const { mimeType } = distribution;
  if (!result.isSuccess() || !mimeType || !result.contentType) return;

  const actual = result.contentType.split(';')[0].trim();
  if (compressionMediaTypes.has(actual)) return;

  const acceptable =
    distribution.compressedMimeType === undefined
      ? [mimeType]
      : [mimeType, distribution.compressedMimeType];
  if (!acceptable.includes(actual)) {
    const expected = distribution.compressedMimeType ?? mimeType;
    result.warnings.push(
      `Server Content-Type ${actual} does not match declared media type ${expected}`,
    );
  }
}
