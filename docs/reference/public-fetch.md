# @lde/public-fetch

Fetch URLs taken from other people’s data – a dataset, a manifest, a registry
entry – from a process that runs inside a private network, without letting that
data point the process at internal addresses.

```ts
import { fetchPublic, readJson } from '@lde/public-fetch';

const response = await fetchPublic(urlFromSomeonesData, {
  signal,
  headers: { Accept: '*/*' },
});
const document = await readJson(response);
```

## Installation

```sh
npm install @lde/public-fetch
```

## Why

A publisher controls the URLs in their data. A process that fetches them from
inside a cluster can be made to request internal services or a cloud metadata
address that nobody outside could reach – server-side request forgery. The
attacker rarely sees the response, but the requests alone can trigger actions or
reveal what exists.

## What it refuses

`isPublicWebUrl(url)` is `false` for:

- anything other than `http` and `https`;
- anything other than public unicast addresses: loopback, private, shared,
  link-local, benchmarking, multicast and reserved space, in IPv4 and IPv6, and
  the IPv6 forms that carry an IPv4 address (mapped, compatible, NAT64 and 6to4),
  as well as the decimal forms the URL parser normalises;
- a single-label host, such as a Kubernetes service name, and names ending in
  `.localhost`, `.local`, `.internal` or `.svc`, with or without a trailing dot.

`fetchPublic(url, options)` follows redirects itself, one hop at a time, and
checks every target, so a public URL redirecting to an internal one is refused
with a `RefusedUrlError` rather than followed. It gives up after `maxRedirects`
hops, 10 by default. Like `fetch`, it drops `Authorization`, `Cookie` and
`Proxy-Authorization` on a redirect to another origin, and returns a redirect
whose `Location` cannot be parsed as it is. It is meant for `GET`: it repeats the
request on every hop.

`readJson(response, maxBytes)` reads at most `maxBytes` of the body, 20 MiB by
default, so a large or endless response cannot exhaust memory. It throws a
`ResponseTooLargeError` when the body is larger, and a `SyntaxError` when it is
not JSON.

## Limits

The checks look at URLs, not at DNS, so a public name that resolves to a private
address gets through. Where that matters, run the process under an egress policy
as well.

Request rates are the caller’s concern: pair it with
[@lde/host-limiter](./host-limiter), or with [@lde/resolver](./resolver), which
uses it.
