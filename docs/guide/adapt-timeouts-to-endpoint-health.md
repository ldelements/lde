# Adapt timeouts to endpoint health

By default every SPARQL request gets the same 5-minute budget, so one endpoint that times out repeatedly on heavy queries can stall a run for over an hour on a single dataset. This guide shows how to fast-fail such endpoints with an adaptive timeout policy.

## Configure the adaptive policy

Pass an `adaptiveTimeoutPolicy` factory as the pipeline’s `timeout`:

```typescript
import { adaptiveTimeoutPolicy, Pipeline } from '@lde/pipeline';

const pipeline = new Pipeline({
  // …
  timeout: adaptiveTimeoutPolicy({
    defaultMs: 300_000,
    tightenedMs: 10_000,
    tightenAfterTimeouts: 2,
  }),
});
```

- `defaultMs` – the budget while an endpoint is healthy.
- `tightenedMs` – the reduced budget once an endpoint is tightened; must be less than `defaultMs`.
- `tightenAfterTimeouts` – how many consecutive timeouts at `defaultMs` flip an endpoint from healthy to tightened. A single successful request flips it back.

A timeout at the tightened budget says nothing about the endpoint’s health, so the policy re-probes it: the next request gets `defaultMs` while concurrent ones keep `tightenedMs`. If the probe succeeds, the endpoint relaxes, so a healthy endpoint whose heavy queries need longer than `tightenedMs` recovers on its own. Each probe that times out doubles the number of tightened timeouts before the next one, up to 64, so an endpoint that is really down rarely costs the full `defaultMs`.

The pipeline invokes the factory once per dataset, so policy state resets at each dataset boundary and one bad dataset can’t poison the next.

## How outcomes are classified

Only genuine timeouts – a client-side abort or an upstream HTTP 504 – count toward tightening; other errors are neutral, and any success relaxes the endpoint. `ConsoleReporter` prints transitions as `↘ Tightened` / `↗ Relaxed` lines, so a fast-failed stage is distinguishable from an unexpected speedup. See [timeout policies](../reference/pipeline#timeout-policies) for the full classification and custom policies.
