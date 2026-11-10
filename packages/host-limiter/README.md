# @lde/host-limiter

Zero-dependency scheduling primitive for outbound work: a concurrent map bounded
by a global cap and an adaptive per-host limit, with results in input order and
no head-of-line blocking. Each host’s limit starts at one, rises while the host
keeps up and halves when it fails, as TCP’s congestion window does. Use `createHostLimiter` when tasks arrive from several
callers that must share one set of caps.

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
  2, // at most 2 against any one host, starting at 1
  async (url) => fetch(url).catch((error) => error),
);
```

## Documentation

See the [full documentation](https://ldelements.org/reference/host-limiter).
