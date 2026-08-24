# @lde/host-limiter

A concurrent map bounded by a **global** cap and a **per-host** cap, with
results in input order and no head-of-line blocking. Zero dependencies, so the
lowest package in the graph can use it.

```ts
import { hostKeyOf, mapHostLimited } from '@lde/host-limiter';

const responses = await mapHostLimited(
  urls,
  urls.map(hostKeyOf),
  8, // at most 8 requests in flight overall
  2, // at most 2 against any one host
  async (url) => fetch(url).catch((error) => error),
);
```

## Installation

```sh
npm install @lde/host-limiter
```

## Why two caps

The global cap bounds the work; the per-host cap keeps items that share an
origin from arriving as the burst that trips a rate limiter (HTTP 429). Every
package here reads other people’s endpoints, and a workspace-wide run should not
look like an attack.

**No head-of-line blocking.** When the next queued item’s host is saturated it is
skipped in favour of a later item on a different host, so a slow origin never
sets the pace for the whole run. The skipped host always has a task in flight,
whose completion re-runs the scheduler, so the queue always drains.

**Results come back in input order** however the tasks complete, so a caller can
pair results with inputs positionally.

## Contract

- `task` **should not reject.** Callers wrap failures into a result value – the
  way [`probeMany`](./distribution-probe) returns a `NetworkError` in the failing
  slot – because a rejection abandons the results of every task that had already
  settled. A task that rejects anyway rejects the returned promise with that
  reason; it does not hang, and it does not surface as an unhandled rejection.
- `hostKeyOf(url)` is the host, falling back to the full href when the URL has no
  authority, so a `urn:` or `file:` URL gets its own budget rather than sharing a
  single empty-string bucket.
- `positiveIntOrDefault(value, fallback)` clamps a caller-supplied limit: zero,
  negative, fractional and `NaN` would stall the scheduler or overrun the cap, so
  they fall back rather than being trusted.

## Users

[@lde/distribution-probe](./distribution-probe) bounds a batch of probes with it,
and [@lde/resolver](./resolver) bounds its outbound resolutions.
