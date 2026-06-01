import { compressionMediaTypes, Distribution } from '@lde/dataset';
import { Parser } from 'n3';

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
}

const DEFAULT_SPARQL_QUERY = 'SELECT * { ?s ?p ?o } LIMIT 1';
const DEFAULT_TIMEOUT_MS = 5000;

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
  } catch (e) {
    const responseTimeMs = Math.round(performance.now() - start);
    return new NetworkError(
      url,
      e instanceof Error ? e.message : String(e),
      responseTimeMs,
    );
  }
}

function resolveOptions(
  options: ProbeOptions | undefined,
): Required<ProbeOptions> {
  return {
    timeoutMs: options?.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    headers: options?.headers ?? new Headers(),
    sparqlQuery: options?.sparqlQuery ?? DEFAULT_SPARQL_QUERY,
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
      ? validateBody(body, getResponse.headers.get('Content-Type'))
      : null;
    const responseTimeMs = Math.round(performance.now() - start);
    const result = new DataDumpProbeResult(
      url,
      getResponse,
      responseTimeMs,
      failureReason,
    );
    checkContentTypeMismatch(result, distribution.mimeType);
    return result;
  }

  const responseTimeMs = Math.round(performance.now() - start);
  const result = new DataDumpProbeResult(url, headResponse, responseTimeMs);
  checkContentTypeMismatch(result, distribution.mimeType);
  return result;
}

const rdfContentTypes = [
  'text/turtle',
  'application/n-triples',
  'application/n-quads',
];

function validateBody(body: string, contentType: string | null): string | null {
  if (body.length === 0) {
    return 'Distribution is empty';
  }

  if (contentType && rdfContentTypes.some((t) => contentType.startsWith(t))) {
    try {
      const parser = new Parser();
      const quads = parser.parse(body);
      if (quads.length === 0) {
        return 'Distribution contains no RDF triples';
      }
    } catch (e) {
      return e instanceof Error ? e.message : String(e);
    }
  }

  return null;
}

/**
 * Compare the declared MIME type from the dataset registry against the
 * server's Content-Type header. Adds a warning when they disagree.
 */
function checkContentTypeMismatch(
  result: DataDumpProbeResult,
  declaredMimeType: string | undefined,
): void {
  if (!result.isSuccess() || !declaredMimeType || !result.contentType) return;

  const actual = result.contentType.split(';')[0].trim();
  if (compressionMediaTypes.has(actual)) return;

  if (actual !== declaredMimeType) {
    result.warnings.push(
      `Server Content-Type ${actual} does not match declared media type ${declaredMimeType}`,
    );
  }
}
