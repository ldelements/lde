# @lde/host-limiter

Zero-dependency scheduling primitive for outbound work: a concurrent map bounded
by a global cap and a per-host cap, with results in input order and no
head-of-line blocking – a saturated host yields to items on other hosts rather
than stalling the queue.

## Installation

```sh
npm install @lde/host-limiter
```

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

## Documentation

See the [full documentation](https://ldelements.org/reference/host-limiter).
