/**
 * Coarse outcome of a manifest validation. On failure the reason describes
 * *what kind* of failure occurred, not a detailed diagnosis — only enough to
 * tell apart an unreachable host from a malformed document.
 */
export type ManifestValidationReason =
  | 'valid-manifest'
  | 'timeout'
  | 'network-error'
  | 'http-error'
  | 'invalid-json'
  | 'binary-content'
  | 'not-a-manifest';

/**
 * Verdict returned by {@link validateManifest}.
 */
export interface ManifestValidation {
  /** Whether the URL dereferenced to a valid IIIF Presentation Manifest. */
  valid: boolean;
  /** Coarse classification of the outcome. */
  reason: ManifestValidationReason;
}

/**
 * Options for {@link validateManifest}.
 */
export interface ValidateManifestOptions {
  /**
   * `fetch` implementation to use. Injectable for testing; defaults to the
   * global `fetch`.
   */
  fetch?: typeof globalThis.fetch;
  /** Per-request timeout in milliseconds. Defaults to 10 000. */
  timeoutMs?: number;
}

const IIIF_PRESENTATION_CONTEXT = 'iiif.io/api/presentation/';
const DEFAULT_TIMEOUT_MS = 10_000;

/**
 * Dereference a URL and check whether it is a valid IIIF Presentation
 * Manifest. Never throws; every outcome is reported as a
 * {@link ManifestValidation}.
 */
export async function validateManifest(
  url: string,
  options?: ValidateManifestOptions,
): Promise<ManifestValidation> {
  const doFetch = options?.fetch ?? globalThis.fetch;
  const timeoutMs = options?.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  let response: Response;
  try {
    response = await doFetch(url, {
      headers: { Accept: 'application/ld+json, application/json' },
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (error) {
    return { valid: false, reason: classifyFetchError(error) };
  }

  if (!response.ok) {
    return { valid: false, reason: 'http-error' };
  }

  // A manifest is JSON. When the server announces a binary media type, skip
  // reading the body: a sampled `schema:contentUrl` can dereference to the
  // full-resolution image, audio or video asset, and `response.json()` would
  // buffer the whole thing before failing to parse it — wasting bandwidth and
  // time in the pipeline that calls this for every sampled manifest. Cancel the
  // stream so the connection is freed without the download.
  if (isBinaryMedia(response.headers.get('content-type'))) {
    await response.body?.cancel();
    return { valid: false, reason: 'binary-content' };
  }

  let body: unknown;
  try {
    body = await response.json();
  } catch {
    return { valid: false, reason: 'invalid-json' };
  }

  if (isPresentationManifest(body)) {
    return { valid: true, reason: 'valid-manifest' };
  }
  return { valid: false, reason: 'not-a-manifest' };
}

/**
 * Whether a `Content-Type` header announces a binary media asset (image, audio
 * or video) rather than a JSON document. Used to skip downloading non-manifest
 * media. A missing or ambiguous type (e.g. `text/plain`, `application/octet-stream`)
 * returns `false` so a manifest served with an odd type is still parsed.
 */
function isBinaryMedia(contentType: string | null): boolean {
  if (contentType === null) return false;
  const mediaType = contentType.toLowerCase();
  return (
    mediaType.startsWith('image/') ||
    mediaType.startsWith('audio/') ||
    mediaType.startsWith('video/')
  );
}

/**
 * Classify a thrown `fetch` error. An aborted request (our own
 * `AbortSignal.timeout` firing, surfaced as `AbortError`/`TimeoutError`)
 * counts as a timeout; anything else (DNS failure, connection refused, TLS) is
 * a network error.
 */
function classifyFetchError(error: unknown): ManifestValidationReason {
  if (
    error instanceof Error &&
    (error.name === 'AbortError' || error.name === 'TimeoutError')
  ) {
    return 'timeout';
  }
  return 'network-error';
}

/**
 * Structural check: the document declares an IIIF Presentation `@context` and
 * a manifest `type` (`Manifest` in v3, `sc:Manifest` in v2). The version
 * segment of the context is not constrained, matching the forwards-compatible
 * spirit of the detection query.
 */
function isPresentationManifest(body: unknown): boolean {
  if (typeof body !== 'object' || body === null) return false;
  const document = body as Record<string, unknown>;
  return (
    hasPresentationContext(document['@context']) && hasManifestType(document)
  );
}

function hasPresentationContext(context: unknown): boolean {
  return contextStrings(context).some((value) =>
    value.includes(IIIF_PRESENTATION_CONTEXT),
  );
}

/**
 * Flatten a JSON-LD `@context` to the string IRIs it contains. The value may
 * be a string, an array (mixing strings and objects), or a single object.
 */
function contextStrings(context: unknown): string[] {
  if (typeof context === 'string') return [context];
  if (Array.isArray(context)) {
    return context.flatMap((entry) => contextStrings(entry));
  }
  if (typeof context === 'object' && context !== null) {
    return Object.values(context).flatMap((entry) => contextStrings(entry));
  }
  return [];
}

function hasManifestType(document: Record<string, unknown>): boolean {
  const types = [document['type'], document['@type']]
    .flatMap((value) => (Array.isArray(value) ? value : [value]))
    .filter((value): value is string => typeof value === 'string');
  return types.includes('Manifest') || types.includes('sc:Manifest');
}
