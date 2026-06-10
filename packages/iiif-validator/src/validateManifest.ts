import { normalize } from '@iiif/parser/presentation-3';
import { upgrade } from '@iiif/parser/upgrader';

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
  | 'not-a-manifest'
  | 'does-not-load';

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
      // Request with `Accept: */*`, matching what real IIIF viewers (Mirador,
      // Universal Viewer) send via the browser `fetch` default. A more specific
      // `application/ld+json` is technically correct, but some manifest hosts do
      // backwards content negotiation: they serve the manifest to `*/*` yet 404
      // a JSON-specific request. Asking for anything keeps the validator as
      // permissive as the viewers whose access it stands in for.
      headers: { Accept: '*/*' },
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

  if (!isPresentationManifest(body)) {
    return { valid: false, reason: 'not-a-manifest' };
  }

  if (!loadsInViewer(body)) {
    return { valid: false, reason: 'does-not-load' };
  }

  return { valid: true, reason: 'valid-manifest' };
}

/**
 * Whether a manifest-shaped document survives the load path that real IIIF
 * viewers run. The dominant Vault/`@iiif/parser`-based viewers (Mirador 4,
 * Clover, Theseus) eagerly upgrade every manifest to Presentation 3 and
 * normalise the whole tree on load; a structural deviation that crashes that
 * pass — e.g. a `null` where an `AnnotationPage` belongs — makes the manifest
 * fail to load even though it parses as JSON and is manifest-shaped. Running
 * the same `upgrade()` then `normalize()` here reproduces that load: a throw
 * from either step means no viewer would render it. `upgrade()` is
 * version-agnostic (a no-op for documents already in v3), so this single path
 * covers both v2 (`sc:Manifest`) and v3 documents.
 */
function loadsInViewer(body: unknown): boolean {
  try {
    normalize(upgrade(body));
    return true;
  } catch {
    return false;
  }
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
