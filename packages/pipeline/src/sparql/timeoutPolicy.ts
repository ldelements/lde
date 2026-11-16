/**
 * Outcome of a single SPARQL request attempt, as reported back to a
 * {@link TimeoutPolicy} so it can adapt the budget for subsequent requests.
 *
 * - `ok` – the request resolved successfully (the HTTP response was accepted
 *   and the body started streaming).
 * - `timeout` – the per-call {@link AbortSignal} fired, or the endpoint
 *   returned an HTTP 504 (upstream-reported timeout). Both are semantically
 *   ‘the endpoint did not deliver in time’.
 * - `error` – any other failure (4xx other than 504, parser errors, etc.).
 *   Neutral with respect to adaptive tightening.
 */
export type TimeoutOutcome = 'ok' | 'error' | 'timeout';

/** Context passed to {@link TimeoutPolicy.beforeRequest}. */
export interface BeforeRequestContext {
  /** Endpoint URL the upcoming request will be sent to. */
  endpoint: URL;
}

/**
 * Budget that {@link TimeoutPolicy.beforeRequest} hands out for one request
 * attempt. Callers pass this same object back as
 * {@link AfterRequestContext.budget}, so a policy can tell by identity which
 * attempt is reporting.
 */
export interface RequestBudget {
  /** Timeout to apply to the attempt, in milliseconds. */
  readonly timeoutMs: number;
}

/** Context passed to {@link TimeoutPolicy.afterRequest}. */
export interface AfterRequestContext {
  /** Endpoint URL the request was sent to. */
  endpoint: URL;
  /** Classified outcome of the request. */
  outcome: TimeoutOutcome;
  /** Wall-clock duration of the request attempt, in milliseconds. */
  durationMs: number;
  /**
   * The object {@link TimeoutPolicy.beforeRequest} returned for this
   * attempt – the same object, not a copy.
   */
  budget: RequestBudget;
  /** The raw error, when {@link outcome} is `'error'` or `'timeout'`. */
  error?: unknown;
}

/**
 * Decides the timeout budget for each SPARQL request and observes the
 * outcome. Implementations are free to adapt the budget based on recent
 * behaviour – see {@link AdaptiveTimeoutPolicy} for the built-in adaptive
 * implementation, and {@link ConstantTimeoutPolicy} for fixed-budget
 * behaviour.
 *
 * Hooks are synchronous because they sit on the request hot path; async
 * work is not supported.
 */
export interface TimeoutPolicy {
  /**
   * Returns the budget to apply to the upcoming request. Called once per
   * attempt, retries included, so a retry can already use a tightened
   * budget.
   */
  beforeRequest(context: BeforeRequestContext): RequestBudget;
  /**
   * Reports the outcome of the request that {@link beforeRequest} budgeted,
   * passing back the budget it returned. Called once per attempt,
   * regardless of outcome.
   */
  afterRequest(context: AfterRequestContext): void;
  /**
   * Optional observer subscription for state transitions. Returns an
   * `unsubscribe` function. Policies that don’t transition (e.g. constant)
   * may omit this hook.
   */
  subscribe?(observer: TimeoutPolicyObserver): () => void;
}

/** A single tighten/relax transition for one endpoint. */
export interface TimeoutTransitionEvent {
  /** Endpoint whose timeout budget changed. */
  endpoint: URL;
  /** Budget in effect before the transition. */
  fromTimeoutMs: number;
  /** Budget in effect after the transition. */
  toTimeoutMs: number;
  /**
   * Number of consecutive timeouts at the default budget observed at the
   * moment of the transition. For a `relax` event, this is the run that
   * ended in the `ok` that triggered relaxation.
   */
  consecutiveTimeouts: number;
}

/**
 * Observer that receives notifications when a policy tightens or relaxes
 * its budget for an endpoint. Both hooks are optional.
 */
export interface TimeoutPolicyObserver {
  /** Called when the policy flips an endpoint to the tightened budget. */
  onTighten?(event: TimeoutTransitionEvent): void;
  /** Called when the policy relaxes an endpoint back to the default budget. */
  onRelax?(event: TimeoutTransitionEvent): void;
}

/**
 * Returns the same timeout for every request. Use this as the
 * backwards-compatible default for callers that don’t want adaptive
 * behaviour.
 */
export class ConstantTimeoutPolicy implements TimeoutPolicy {
  constructor(private readonly timeoutMs: number) {
    if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
      throw new Error(
        `ConstantTimeoutPolicy: timeoutMs must be a positive finite number, received ${timeoutMs}`,
      );
    }
  }

  beforeRequest(_context: BeforeRequestContext): RequestBudget {
    return { timeoutMs: this.timeoutMs };
  }

  afterRequest(_context: AfterRequestContext): void {
    // Constant policy is stateless – outcomes never affect future budgets.
  }
}

/** Options for {@link AdaptiveTimeoutPolicy}. */
export interface AdaptiveTimeoutPolicyOptions {
  /** Budget applied while the endpoint is healthy. Must be positive. */
  defaultMs: number;
  /**
   * Budget applied after {@link tightenAfterTimeouts} consecutive timeouts.
   * Must satisfy `tightenedMs < defaultMs`.
   */
  tightenedMs: number;
  /**
   * Number of consecutive timeouts that flips an endpoint to the
   * {@link tightenedMs} budget. Must be an integer ≥ 1.
   */
  tightenAfterTimeouts: number;
}

/**
 * Adaptive per-endpoint policy: after {@link AdaptiveTimeoutPolicyOptions.tightenAfterTimeouts}
 * consecutive timeouts on the same endpoint, subsequent requests use the
 * tightened budget so the pipeline fast-fails instead of waiting out the
 * full default budget. A single successful request relaxes the endpoint
 * back to the default budget.
 *
 * A timeout at the tightened budget says nothing about the endpoint’s
 * health – a healthy endpoint’s heavy query may simply need longer – so it
 * does not count toward tightening. Instead, it brings a re-probe at the
 * default budget closer, one probe at a time: concurrent requests keep the
 * tightened budget until the probe reports. The first timeout at the
 * tightened budget makes a probe due. If the probe succeeds, the endpoint
 * relaxes; if it times out, the gap until the next probe doubles – 1, 2, 4…
 * timeouts at the tightened budget, up to 64. A probe that fails with an
 * error keeps the current gap. A healthy-but-slow endpoint therefore
 * recovers after one lost request, while an endpoint that is genuinely
 * down waits out the full default budget only on a shrinking share of
 * requests.
 *
 * State is in-memory and tied to the policy instance – Pipeline creates a
 * fresh instance per dataset so one offending dataset doesn’t poison the
 * next.
 *
 * @example
 * ```ts
 * const factory = adaptiveTimeoutPolicy({
 *   defaultMs: 300_000,
 *   tightenedMs: 10_000,
 *   tightenAfterTimeouts: 2,
 * });
 * ```
 */
export class AdaptiveTimeoutPolicy implements TimeoutPolicy {
  private readonly states = new Map<string, EndpointState>();
  private readonly observers = new Set<TimeoutPolicyObserver>();

  constructor(private readonly options: AdaptiveTimeoutPolicyOptions) {
    if (!Number.isFinite(options.defaultMs) || options.defaultMs <= 0) {
      throw new Error(
        `AdaptiveTimeoutPolicy: \`defaultMs\` must be a positive finite number, received ${options.defaultMs}`,
      );
    }
    if (!Number.isFinite(options.tightenedMs) || options.tightenedMs <= 0) {
      throw new Error(
        `AdaptiveTimeoutPolicy: \`tightenedMs\` must be a positive finite number, received ${options.tightenedMs}`,
      );
    }
    if (!(options.tightenedMs < options.defaultMs)) {
      throw new Error(
        `AdaptiveTimeoutPolicy: \`tightenedMs\` (${options.tightenedMs}) must be less than \`defaultMs\` (${options.defaultMs})`,
      );
    }
    if (
      !Number.isInteger(options.tightenAfterTimeouts) ||
      options.tightenAfterTimeouts < 1
    ) {
      throw new Error(
        `AdaptiveTimeoutPolicy: \`tightenAfterTimeouts\` must be an integer ≥ 1, received ${options.tightenAfterTimeouts}`,
      );
    }
  }

  beforeRequest(context: BeforeRequestContext): RequestBudget {
    const { health } = this.stateFor(context.endpoint);
    if (health.status === 'healthy') {
      return { timeoutMs: this.options.defaultMs };
    }
    if (health.probe.status === 'due') {
      const budget = { timeoutMs: this.options.defaultMs };
      health.probe = { status: 'inFlight', budget };
      return budget;
    }
    return { timeoutMs: this.options.tightenedMs };
  }

  afterRequest(context: AfterRequestContext): void {
    const state = this.stateFor(context.endpoint);
    const { health } = state;
    if (context.outcome === 'ok') {
      const priorCount = state.consecutiveTimeouts;
      state.consecutiveTimeouts = 0;
      state.health = { status: 'healthy' };
      if (health.status === 'tightened') {
        this.notify('relax', {
          endpoint: context.endpoint,
          fromTimeoutMs: this.options.tightenedMs,
          toTimeoutMs: this.options.defaultMs,
          consecutiveTimeouts: priorCount,
        });
      }
      return;
    }
    if (
      health.status === 'tightened' &&
      health.probe.status === 'inFlight' &&
      health.probe.budget === context.budget
    ) {
      if (context.outcome === 'timeout') health.failedProbes += 1;
      health.probe = {
        status: 'waiting',
        timeoutsUntilDue: timeoutsBetweenProbes(health.failedProbes),
      };
    }
    if (context.outcome === 'timeout') {
      if (context.budget.timeoutMs < this.options.defaultMs) {
        // Too short a budget to judge the endpoint by: bring a re-probe
        // closer instead.
        if (
          health.status === 'tightened' &&
          health.probe.status === 'waiting'
        ) {
          health.probe.timeoutsUntilDue -= 1;
          if (health.probe.timeoutsUntilDue === 0) {
            health.probe = { status: 'due' };
          }
        }
        return;
      }
      state.consecutiveTimeouts += 1;
      if (
        health.status === 'healthy' &&
        state.consecutiveTimeouts >= this.options.tightenAfterTimeouts
      ) {
        state.health = {
          status: 'tightened',
          probe: {
            status: 'waiting',
            timeoutsUntilDue: timeoutsBetweenProbes(0),
          },
          failedProbes: 0,
        };
        this.notify('tighten', {
          endpoint: context.endpoint,
          fromTimeoutMs: this.options.defaultMs,
          toTimeoutMs: this.options.tightenedMs,
          consecutiveTimeouts: state.consecutiveTimeouts,
        });
      }
    }
    // 'error' is neutral.
  }

  subscribe(observer: TimeoutPolicyObserver): () => void {
    this.observers.add(observer);
    return () => {
      this.observers.delete(observer);
    };
  }

  private stateFor(endpoint: URL): EndpointState {
    const key = endpoint.toString();
    let state = this.states.get(key);
    if (!state) {
      state = { health: { status: 'healthy' }, consecutiveTimeouts: 0 };
      this.states.set(key, state);
    }
    return state;
  }

  private notify(
    kind: 'tighten' | 'relax',
    event: TimeoutTransitionEvent,
  ): void {
    for (const observer of this.observers) {
      const handler =
        kind === 'tighten' ? observer.onTighten : observer.onRelax;
      handler?.(event);
    }
  }
}

/**
 * Factory returning a fresh {@link ConstantTimeoutPolicy} on every call.
 * Pass this to {@link PipelineOptions.timeout}.
 */
export function constantTimeoutPolicy(
  timeoutMs: number,
): () => ConstantTimeoutPolicy {
  // Validate eagerly so misconfiguration is caught at factory creation,
  // not deferred until the first dataset boundary.

  new ConstantTimeoutPolicy(timeoutMs);
  return () => new ConstantTimeoutPolicy(timeoutMs);
}

/**
 * Factory returning a fresh {@link AdaptiveTimeoutPolicy} on every call.
 * Pass this to {@link PipelineOptions.timeout}; the Pipeline invokes
 * the factory once per dataset so state resets between datasets.
 */
export function adaptiveTimeoutPolicy(
  options: AdaptiveTimeoutPolicyOptions,
): () => AdaptiveTimeoutPolicy {
  // Validate eagerly (see {@link constantTimeoutPolicy}).

  new AdaptiveTimeoutPolicy(options);
  return () => new AdaptiveTimeoutPolicy(options);
}

/**
 * Upper bound on the number of timeouts at the tightened budget between two
 * probes, so an endpoint that comes back late in a long run still gets
 * re-probed.
 */
const maxTimeoutsBetweenProbes = 64;

/**
 * Timeouts at the tightened budget until the next probe is due, doubling
 * with each failed probe.
 */
function timeoutsBetweenProbes(failedProbes: number): number {
  return Math.min(2 ** failedProbes, maxTimeoutsBetweenProbes);
}

/**
 * Where a tightened endpoint’s next re-probe stands.
 *
 * - `waiting` – that many more timeouts at the tightened budget make a probe
 *   due.
 * - `due` – the next request is the probe.
 * - `inFlight` – the probe was handed out with this budget and has not
 *   reported yet; concurrent requests keep the tightened budget meanwhile.
 */
type Probe =
  | { status: 'waiting'; timeoutsUntilDue: number }
  | { status: 'due' }
  | { status: 'inFlight'; budget: RequestBudget };

type EndpointHealth =
  | { status: 'healthy' }
  | {
      status: 'tightened';
      probe: Probe;
      /** Probes that timed out since the endpoint tightened. */
      failedProbes: number;
    };

interface EndpointState {
  health: EndpointHealth;
  /** Consecutive timeouts at the default budget since the last `ok`. */
  consecutiveTimeouts: number;
}
