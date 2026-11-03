import { BlockList, isIP } from 'node:net';

/** Options for {@link fetchPublic}. */
export interface FetchPublicOptions {
  /** Aborts the request, including any redirect it is following. */
  signal?: AbortSignal;
  /** Request headers, sent on every hop. */
  headers?: RequestInit['headers'];
  /** `fetch` implementation to use. Injectable for testing; defaults to the global `fetch`. */
  fetch?: typeof globalThis.fetch;
}

/** Thrown by {@link fetchPublic} for a URL, or a redirect target, that is not public. */
export class RefusedUrlError extends Error {
  constructor(url: string) {
    super(`${url} is not a public web address`);
    this.name = 'RefusedUrlError';
  }
}

/** Thrown while reading the body of a {@link fetchPublic} response larger than 20 MiB. */
export class ResponseTooLargeError extends Error {
  constructor() {
    super(`response body exceeds ${MAX_BYTES} bytes`);
    this.name = 'ResponseTooLargeError';
  }
}

/**
 * `fetch` a URL that came from someone else’s data, refusing to reach anything
 * but a public web address: not a private, loopback or link-local address, nor a
 * host that only resolves internally. Redirects are followed one hop at a time
 * so that each target is checked too: a public URL redirecting to an internal
 * one is refused, not followed.
 *
 * The response body is bounded: reading it – with `json()`, `text()` or
 * otherwise – fails with a {@link ResponseTooLargeError} past 20 MiB, so a large
 * or endless body cannot exhaust memory.
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
      return bounded(response, current, hop > 0);
    }
    // An unread body keeps its connection until garbage collection.
    await response.body?.cancel();
    if (hop >= MAX_REDIRECTS) {
      throw new Error(`${url} redirected more than ${MAX_REDIRECTS} times`);
    }
    // As `fetch` does on a cross-origin redirect: credentials meant for one
    // origin must not reach another.
    if (new URL(target).origin !== new URL(current).origin) {
      headers = withoutCredentials(headers);
    }
    current = target;
  }
}

const MAX_REDIRECTS = 10;

const MAX_BYTES = 20 * 1024 * 1024;

/**
 * The response with a body that errors past {@link MAX_BYTES}, whatever
 * `Content-Length` says, and with the `url` and `redirected` that `fetch` would
 * have reported had it followed the redirects itself.
 */
async function bounded(
  response: Response,
  url: string,
  redirected: boolean,
): Promise<Response> {
  // `fetch` passes on any three-digit status a server sends, but a `Response`
  // can only be made with one from 200 to 599.
  if (response.status < 200 || response.status > 599) {
    await response.body?.cancel();
    throw new Error(`${url} answered with status ${response.status}`);
  }
  const result = new Response(
    response.body && boundedStream(response.body, response.headers),
    response,
  );
  Object.defineProperties(result, {
    url: { value: url },
    redirected: { value: redirected },
  });
  return result;
}

function boundedStream(
  body: ReadableStream<Uint8Array>,
  headers: Headers,
): ReadableStream<Uint8Array> {
  const reader = body.getReader();
  const declared = Number(headers.get('content-length'));
  let received = 0;
  return new ReadableStream(
    {
      async pull(controller) {
        // A declared length above the limit fails before anything is read.
        if (declared > MAX_BYTES) {
          await reader.cancel();
          controller.error(new ResponseTooLargeError());
          return;
        }
        const { done, value } = await reader.read();
        if (done) {
          controller.close();
          return;
        }
        received += value.byteLength;
        if (received > MAX_BYTES) {
          await reader.cancel();
          controller.error(new ResponseTooLargeError());
          return;
        }
        controller.enqueue(value);
      },
      cancel: (reason) => reader.cancel(reason),
    },
    // Read only when the caller does: a stream otherwise pulls a chunk as soon
    // as it is made, downloading part of a body the caller may only cancel.
    { highWaterMark: 0 },
  );
}

/**
 * Whether a URL may be fetched by a process inside a private network: an `http` or
 * `https` URL that does not name a private, loopback or link-local address, nor a
 * host that only resolves internally – a single label such as a Kubernetes service
 * name, or a `.localhost`, `.local`, `.internal` or `.svc` name.
 *
 * It looks only at the URL, so it cannot see a public name that resolves to a
 * private address. Pair it with an egress policy where that matters.
 */
function isPublicWebUrl(url: string): boolean {
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
