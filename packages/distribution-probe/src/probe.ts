import { compressionMediaTypes, Distribution } from '@lde/dataset';
import { rdfParser } from 'rdf-parse';
import { Readable } from 'node:stream';

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
}

const DEFAULT_SPARQL_QUERY = 'SELECT * { ?s ?p ?o } LIMIT 1';
const DEFAULT_TIMEOUT_MS = 5000;
const DEFAULT_RETRIES = 2;

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
const SPARQL_RDF_RESULTS = 'application/n-triples';

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
 * for small or unknown-size bodies).
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
  return [SPARQL_RDF_RESULTS];
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
  const body = await response.text();
  if (body.length === 0) {
    return 'SPARQL endpoint returned an empty response';
  }

  if (queryType === 'CONSTRUCT' || queryType === 'DESCRIBE') {
    // Body should be RDF; a non-empty response is sufficient to confirm the
    // endpoint answered. Deep parse validation is the data-dump path’s job.
    return null;
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

  const contentLength = headResponse.headers.get('Content-Length');
  const contentLengthBytes = contentLength ? parseInt(contentLength) : 0;

  // For small or unknown-size files, do a GET to validate body content.
  // This also handles servers that incorrectly return 0 Content-Length for HEAD.
  if (contentLengthBytes <= 10_240) {
    const getResponse = await fetch(url, {
      method: 'GET',
      ...requestOptions,
    });
    const body = await getResponse.text();
    const isHttpSuccess = getResponse.status >= 200 && getResponse.status < 400;
    const failureReason = isHttpSuccess
      ? await validateBody(
          body,
          getResponse.headers.get('Content-Type'),
          url,
          options.timeoutMs,
        )
      : null;
    const responseTimeMs = Math.round(performance.now() - start);
    const result = new DataDumpProbeResult(
      url,
      getResponse,
      responseTimeMs,
      failureReason,
    );
    checkContentTypeMismatch(result, distribution);
    return result;
  }

  const responseTimeMs = Math.round(performance.now() - start);
  const result = new DataDumpProbeResult(url, headResponse, responseTimeMs);
  checkContentTypeMismatch(result, distribution);
  return result;
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

async function validateBody(
  body: string,
  contentType: string | null,
  baseIRI: string,
  timeoutMs: number,
): Promise<string | null> {
  if (body.length === 0) {
    return 'Distribution is empty';
  }

  // Media types are case-insensitive (RFC 9110 §8.3.1), so normalise before
  // matching the lower-case allow-list — a server sending `Application/LD+JSON`
  // must still have its body validated.
  const serialization = contentType?.split(';')[0].trim().toLowerCase();
  if (!serialization || !rdfContentTypes.includes(serialization)) {
    return null;
  }

  const outcome = await classifyRdfBody(
    body,
    serialization,
    baseIRI,
    timeoutMs,
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
 * `timeoutMs` because a JSON-LD `@context` is fetched from its origin, and a
 * slow or hanging context host would otherwise stall the probe past its budget;
 * on expiry — and likewise when a remote `@context` is unreachable — the outcome
 * is 'inconclusive', so a valid distribution is never flagged faulty for a
 * context host's failure. `baseIRI` resolves any relative IRIs in the document.
 */
function classifyRdfBody(
  body: string,
  contentType: string,
  baseIRI: string,
  timeoutMs: number,
): Promise<RdfBodyOutcome> {
  return new Promise<RdfBodyOutcome>((resolve) => {
    const quads = rdfParser.parse(Readable.from([body]), {
      contentType,
      baseIRI,
    });
    const timer = setTimeout(() => settle({ type: 'inconclusive' }), timeoutMs);
    let settled = false;
    function settle(outcome: RdfBodyOutcome): void {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      quads.destroy();
      resolve(outcome);
    }
    quads
      .on('data', () => settle({ type: 'hasTriples' }))
      .on('error', (error: Error) =>
        settle(
          isRemoteContextError(error)
            ? { type: 'inconclusive' }
            : { type: 'parseError', message: error.message },
        ),
      )
      .on('end', () => settle({ type: 'empty' }));
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
