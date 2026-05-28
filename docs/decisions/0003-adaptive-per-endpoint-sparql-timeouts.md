# 3. Adopt adaptive per-endpoint SPARQL timeouts

Date: 2026-05-28

## Status

Accepted

## Context

The DKG pipeline analyses ~500 third-party SPARQL endpoints. Some endpoints (notably TriplyDB-hosted ones) serve light queries quickly but reliably time out on heavy analytical queries, returning HTTP 504 after their own internal query budget elapses. With a fixed 5-minute client-side timeout, a single offending dataset can spend ~80 minutes cycling through stage-level timeouts before the pipeline moves on.

We need the pipeline to learn from “this endpoint just timed out twice” and apply a tighter budget to subsequent requests against the same endpoint, so light queries still succeed while heavy queries fast-fail.

## Decision

`SparqlConstructExecutor` and `SparqlItemSelector` accept a per-call `TimeoutPolicy` injected by the `Pipeline` at dataset boundaries. Two built-in policies ship:

- `ConstantTimeoutPolicy` – returns the same budget for every request. Used as the implicit default (`constantTimeoutPolicy(300_000)`) when `PipelineOptions.timeoutPolicy` is omitted, so existing call sites see no behavioural change.
- `AdaptiveTimeoutPolicy` – tracks consecutive timeouts per endpoint within a dataset. After `threshold` consecutive timeouts, subsequent requests against that endpoint use the short budget; a single successful request relaxes back to the default budget. Construction validates `short < default` and `threshold ≥ 1`.

The `TimeoutPolicy` interface is intentionally narrow:

```ts
interface TimeoutPolicy {
  beforeRequest(context: { endpoint: URL }): number;
  afterRequest(context: {
    endpoint: URL;
    outcome: 'ok' | 'error' | 'timeout';
    durationMs: number;
    error?: unknown;
  }): void;
  subscribe?(observer: TimeoutPolicyObserver): () => void;
}
```

Key decisions:

- **Per-dataset scope.** `PipelineOptions.timeoutPolicy` accepts a `() => TimeoutPolicy` factory. The pipeline invokes it once per dataset so one bad dataset doesn’t poison the next.
- **Per-attempt hooks.** Policy hooks fire inside the `pRetry` callback, not around it, so a retried timeout already runs with the tightened budget.
- **Outcome classification.** HTTP 504 from upstream counts as a `timeout`, alongside `AbortError` / `TimeoutError` from our own `AbortSignal.timeout()`. All other errors are neutral (`error`).
- **Breaking change.** `SparqlConstructExecutorOptions.timeout: number` is removed and replaced by `timeoutPolicy?: TimeoutPolicy`. Pre-release per `AGENTS.md`, so the cleaner API is preferred over a permanent `number | TimeoutPolicy` union. Call sites passing `timeout: 5000` migrate to `timeoutPolicy: new ConstantTimeoutPolicy(5_000)`.
- **Observability.** `ProgressReporter` gains optional `timeoutTightened` / `timeoutRelaxed` hooks. The `Pipeline` subscribes to the policy at each dataset boundary and forwards transitions. `ConsoleReporter` prints `↘ Tightened` / `↗ Relaxed` lines so operators can distinguish a fast-failed stage from an unexpected speedup.
- **No off-the-shelf library.** Circuit breakers (`cockatiel`, `opossum`) implement deny semantics; we want to keep serving requests with a shorter budget. The homegrown ~50-line state machine is the right fit; the interface is stable enough to swap in a fuller resilience framework later if other requirements emerge.

## Consequences

- DKG can opt into `adaptiveTimeoutPolicy({ default: 300_000, short: 10_000, threshold: 2 })` once `@lde/pipeline` is released. Expected effect on the razu.nl case: worst-case wall-clock per troublesome dataset drops from ~80 min to ~15 min, with the same partial output preserved.
- Integrators implementing a custom `TimeoutPolicy` can plug in shared state across datasets by closing over it in the factory.
- `Executor` and `ItemSelector` implementations that thread `ExecuteOptions` / `SelectOptions` through to inner SPARQL calls require no code changes; ones that ignore the options pay only the cost of not benefiting from adaptive behaviour.
