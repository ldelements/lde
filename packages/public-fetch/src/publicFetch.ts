import { BlockList, isIP } from 'node:net';

/** Options for {@link fetchPublic}. */
export interface FetchPublicOptions {
  /** Aborts the request, including any redirect it is following. */
  signal?: AbortSignal;
  /** Request headers, sent on every hop. */
  headers?: RequestInit['headers'];
  /** Redirects followed before giving up. Defaults to 10. */
  maxRedirects?: number;
  /** `fetch` implementation to use. Injectable for testing; defaults to the global `fetch`. */
  fetch?: typeof globalThis.fetch;
}

/** Thrown by {@link fetchPublic} for a URL, or a redirect target, that is not public. */
export class RefusedUrlError extends Error {
  constructor(
    /** The URL that was refused, which may be a redirect target. */
    readonly url: string,
  ) {
    super(`${url} is not a public web address`);
    this.name = 'RefusedUrlError';
  }
}

/** Thrown by {@link readJson} for a body larger than its limit. */
export class ResponseTooLargeError extends Error {
  constructor(
    /** The limit the body exceeded, in bytes. */
    readonly maxBytes: number,
  ) {
    super(`response body exceeds ${maxBytes} bytes`);
    this.name = 'ResponseTooLargeError';
  }
}

/** The default limit for {@link readJson}: 20 MiB. */
export const DEFAULT_MAX_BYTES = 20 * 1024 * 1024;

/**
 * Whether a URL may be fetched by a process inside a private network: an `http` or
 * `https` URL that does not name a private, loopback or link-local address, nor a
 * host that only resolves internally – a single label such as a Kubernetes service
 * name, or a `.localhost`, `.local`, `.internal` or `.svc` name.
 *
 * It looks only at the URL, so it cannot see a public name that resolves to a
 * private address. Pair it with an egress policy where that matters.
 */
export function isPublicWebUrl(url: string): boolean {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    return false;
  }
  // `localhost.` is `localhost`: a fully qualified name may end in a dot.
  const host = parsed.hostname
    .replace(/^\[|\]$/g, '')
    .replace(/\.+$/, '')
    .toLowerCase();
  const family = isIP(host);
  if (family !== 0) {
    return !PRIVATE_ADDRESSES.check(host, family === 4 ? 'ipv4' : 'ipv6');
  }
  return host.includes('.') && !INTERNAL_SUFFIX.test(host);
}

/**
 * `fetch` a URL that came from someone else’s data, refusing to reach anything
 * {@link isPublicWebUrl} rejects. Redirects are followed one hop at a time so
 * that each target is checked too: a public URL redirecting to an internal one
 * is refused, not followed.
 *
 * Meant for `GET`: like `fetch`, it repeats the request on every hop.
 *
 * @throws {RefusedUrlError} when the URL or a redirect target is not public.
 */
export async function fetchPublic(
  url: string,
  options: FetchPublicOptions = {},
): Promise<Response> {
  const doFetch = options.fetch ?? globalThis.fetch;
  const maxRedirects = options.maxRedirects ?? DEFAULT_MAX_REDIRECTS;
  let current = url;
  let headers = options.headers;
  for (let hop = 0; ; hop++) {
    if (!isPublicWebUrl(current)) {
      throw new RefusedUrlError(current);
    }
    const response = await doFetch(current, {
      signal: options.signal,
      headers,
      redirect: 'manual',
    });
    const target = redirectTarget(response, current);
    if (target === undefined) {
      return response;
    }
    // An unread body keeps its connection until garbage collection.
    await response.body?.cancel();
    if (hop >= maxRedirects) {
      throw new Error(`${url} redirected more than ${maxRedirects} times`);
    }
    // As `fetch` does on a cross-origin redirect: credentials meant for one
    // origin must not reach another.
    if (new URL(target).origin !== new URL(current).origin) {
      headers = withoutCredentials(headers);
    }
    current = target;
  }
}

/**
 * Parse a response body as JSON, reading at most `maxBytes` of it, so a large or
 * endless body cannot exhaust memory.
 *
 * @throws {ResponseTooLargeError} when the body exceeds `maxBytes`.
 * @throws {SyntaxError} when the body is not JSON.
 */
export async function readJson(
  response: Response,
  maxBytes = DEFAULT_MAX_BYTES,
): Promise<unknown> {
  const declared = Number(response.headers.get('content-length'));
  if (declared > maxBytes) {
    await response.body?.cancel();
    throw new ResponseTooLargeError(maxBytes);
  }
  if (response.body === null) {
    return JSON.parse('');
  }
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let received = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) {
      break;
    }
    received += value.byteLength;
    if (received > maxBytes) {
      await reader.cancel();
      throw new ResponseTooLargeError(maxBytes);
    }
    chunks.push(value);
  }
  // `TextDecoder` drops a leading byte order mark, as `response.json()` does;
  // some IIS servers send one.
  return JSON.parse(new TextDecoder().decode(Buffer.concat(chunks)));
}

const DEFAULT_MAX_REDIRECTS = 10;

/** The absolute URL a redirect points to, or `undefined` for a response that is
 *  not a redirect, or whose `Location` cannot be followed. */
function redirectTarget(
  response: Response,
  current: string,
): string | undefined {
  const location = response.headers.get('location');
  if (!REDIRECT_STATUSES.has(response.status) || location === null) {
    return undefined;
  }
  try {
    return new URL(location, current).toString();
  } catch {
    return undefined;
  }
}

/** Request headers that authenticate the caller, which a cross-origin redirect drops. */
const CREDENTIAL_HEADERS = ['authorization', 'cookie', 'proxy-authorization'];

function withoutCredentials(
  headers: FetchPublicOptions['headers'],
): FetchPublicOptions['headers'] {
  if (headers === undefined) {
    return undefined;
  }
  const remaining = new Headers(headers);
  for (const name of CREDENTIAL_HEADERS) {
    remaining.delete(name);
  }
  return remaining;
}

const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);

const INTERNAL_SUFFIX = /\.(localhost|local|internal|svc)$/;

const PRIVATE_ADDRESSES = new BlockList();
// Everything that is not ordinary public unicast: private, shared, loopback,
// link-local, benchmarking, protocol-assignment, multicast and reserved space.
for (const [network, prefix] of [
  ['0.0.0.0', 8],
  ['10.0.0.0', 8],
  ['100.64.0.0', 10],
  ['127.0.0.0', 8],
  ['169.254.0.0', 16],
  ['172.16.0.0', 12],
  ['192.0.0.0', 24],
  ['192.168.0.0', 16],
  ['198.18.0.0', 15],
  ['224.0.0.0', 4],
  ['240.0.0.0', 4],
] as const) {
  PRIVATE_ADDRESSES.addSubnet(network, prefix, 'ipv4');
}
// As above, plus the forms that carry an IPv4 address inside IPv6 – compatible,
// NAT64 and 6to4 – which would otherwise smuggle a private one past the list.
for (const [network, prefix] of [
  ['::', 96],
  ['64:ff9b::', 96],
  ['2002::', 16],
  ['fc00::', 7],
  ['fe80::', 10],
  ['ff00::', 8],
] as const) {
  PRIVATE_ADDRESSES.addSubnet(network, prefix, 'ipv6');
}
