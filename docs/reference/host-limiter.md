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
  2, // at most 2 against any one host, starting at 1
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

## An adaptive per-host limit

The per-host cap is a ceiling. Below it, each host gets a limit of its own that
adapts the way TCP’s congestion window does, because the right number differs
per endpoint and nobody knows the publisher’s hardware:

- A host starts at **one** task in flight. Each round of successes doubles the
  limit – a round being as many successes as the current limit – so it goes
  1, 2, 4, 8 in three rounds.
- A task that **throws or rejects** counts as overload and halves the limit.
  From then on the limit grows by one per round instead of doubling.
- **One burst counts once.** When a backend goes down, every task in flight
  fails at about the same moment. Only failures of tasks that started after the
  last decrease halve the limit again, so a crash at 8 lands on 4, not 1.
- The limit grows only when the host had its **whole limit in flight** and more
  tasks waiting. A caller that never fills the limit – sending one request at a
  time, or held back by the global cap – never raises it, so a host isn’t
  suddenly hit at the ceiling once a burst arrives.
- `limiter.pause(host, untilMs)` starts no task for the host before `untilMs`,
  for a host that is down or answered 429 or 503. Afterwards the limit is back
  at one and slow-starts up to half of what it was, so the first task after the
  pause probes whether the host is back. A pause while one runs only extends
  it, and a pause keeps the process alive until it ends.
- `limiter.limitOf(host)` reads the current limit.

`mapHostLimited` builds a fresh limiter per call, and its tasks don’t reject, so
there the limit only slow-starts: each host begins at one and rises to the cap.

A limiter remembers the limits of the 1,000 idle hosts it used most recently.
A host it forgot starts at one task again, so memory doesn’t grow with the
number of hosts a run sees.

## Sharing caps between callers

Each `mapHostLimited` call counts only its own items, so two calls running at the
same time each get the full caps. When tasks arrive from several places at once
and the caps should bound them together, create one limiter and share it:

```ts
import { createHostLimiter, hostKeyOf } from '@lde/host-limiter';

const limiter = createHostLimiter(8, 2);

const response = await limiter.run(hostKeyOf(url), async () => {
  const response = await fetch(url, { signal: AbortSignal.timeout(10_000) });
  // Throw for what load may cause, so the host’s limit comes down.
  if (response.status === 502 || response.status === 503) {
    throw new Error(`HTTP ${response.status}`);
  }
  return response;
});
```

A task does not start until it has a slot, so a timeout it sets on itself does
not count the time spent queueing. It holds the slot until it settles, so it must
not wait on another `run` of the same limiter: once the caps are full of such
tasks, none of them can finish.

## Contract

- `task` **should not reject.** Callers wrap failures into a result value – the
  way [`probeMany`](./distribution-probe) returns a `NetworkError` in the failing
  slot – because a rejection abandons the results of every task that had already
  settled. A task that rejects anyway rejects the returned promise with that
  reason; it does not hang, and it does not surface as an unhandled rejection.
  Work in flight or still queued carries on, unobserved.
- `limiter.run` settles as its task does, so handling a rejection is up to the
  caller. A task that rejects frees its slot and halves its host’s limit, so a
  task should reject only for a failure that load may have caused: a timeout,
  a refused connection, a 502 or 503. A 404 is an answer, not overload.
- `hostKeyOf(url)` is the host, falling back to the full href when the URL has no
  authority, so a `urn:` or `file:` URL gets its own budget rather than sharing a
  single empty-string bucket.
- `positiveIntOrDefault(value, fallback)` clamps a caller-supplied limit: zero,
  negative, fractional and `NaN` would stall the scheduler or overrun the cap, so
  they fall back rather than being trusted.

## Users

[@lde/distribution-probe](./distribution-probe) bounds a batch of probes with it.
[@lde/resolver](./resolver) runs every batch on one limiter, its own or one it is
given to share, turns a failed call into a rejection so the host’s limit comes
down, and pauses a host that asked it to come back later.
