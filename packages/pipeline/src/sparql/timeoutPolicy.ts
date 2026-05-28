/**
 * Outcome of a single SPARQL request attempt, as reported back to a
 * {@link TimeoutPolicy} so it can adapt the budget for subsequent requests.
 *
 * - `ok` — the request resolved successfully (the HTTP response was accepted
 *   and the body started streaming).
 * - `timeout` — the per-call {@link AbortSignal} fired, or the endpoint
 *   returned an HTTP 504 (upstream-reported timeout). Both are semantically
 *   ‘the endpoint did not deliver in time’.
 * - `error` — any other failure (4xx other than 504, parser errors, etc.).
 *   Neutral with respect to adaptive tightening.
 */
export type TimeoutOutcome = 'ok' | 'error' | 'timeout';

/** Context passed to {@link TimeoutPolicy.beforeRequest}. */
export interface BeforeRequestContext {
  /** Endpoint URL the upcoming request will be sent to. */
  endpoint: URL;
}

/** Context passed to {@link TimeoutPolicy.afterRequest}. */
export interface AfterRequestContext {
  /** Endpoint URL the request was sent to. */
  endpoint: URL;
  /** Classified outcome of the request. */
  outcome: TimeoutOutcome;
  /** Wall-clock duration of the request attempt, in milliseconds. */
  durationMs: number;
  /** The raw error, when {@link outcome} is `'error'` or `'timeout'`. */
  error?: unknown;
}

/**
 * Decides the timeout budget for each SPARQL request and observes the
 * outcome. Implementations are free to adapt the budget based on recent
 * behaviour — see {@link AdaptiveTimeoutPolicy} for the built-in adaptive
 * implementation, and {@link ConstantTimeoutPolicy} for fixed-budget
 * behaviour.
 *
 * Hooks are synchronous because they sit on the request hot path; async
 * work is not supported.
 */
export interface TimeoutPolicy {
  /**
   * Returns the timeout (in milliseconds) to apply to the upcoming request.
   * Called once per attempt — including retried attempts inside
   * {@link p-retry}, so a retry can already use a tightened budget.
   */
  beforeRequest(context: BeforeRequestContext): number;
  /**
   * Reports the outcome of the request that {@link beforeRequest} budgeted.
   * Called once per attempt, regardless of outcome.
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
   * Number of consecutive timeouts observed at the moment of the
   * transition. For a `relax` event, this is the run that ended in the
   * `ok` that triggered relaxation.
   */
  consecutiveTimeouts: number;
}

/**
 * Observer that receives notifications when a policy tightens or relaxes
 * its budget for an endpoint. Both hooks are optional.
 */
export interface TimeoutPolicyObserver {
  /** Called when the policy starts using the short budget for an endpoint. */
  onTighten?(event: TimeoutTransitionEvent): void;
  /** Called when the policy returns to the default budget for an endpoint. */
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

  beforeRequest(_context: BeforeRequestContext): number {
    return this.timeoutMs;
  }

  afterRequest(_context: AfterRequestContext): void {
    // Constant policy is stateless — outcomes never affect future budgets.
  }
}

/** Options for {@link AdaptiveTimeoutPolicy}. */
export interface AdaptiveTimeoutPolicyOptions {
  /** Budget applied while the endpoint is healthy. Must be positive. */
  default: number;
  /**
   * Budget applied after {@link threshold} consecutive timeouts.
   * Must satisfy `short < default`.
   */
  short: number;
  /**
   * Number of consecutive timeouts that triggers the switch to {@link short}.
   * Must be an integer ≥ 1.
   */
  threshold: number;
}

interface EndpointState {
  tightened: boolean;
  /** Consecutive timeouts since the last `ok`. */
  consecutiveTimeouts: number;
}

/**
 * Adaptive per-endpoint policy: after a configurable threshold of
 * consecutive timeouts on the same endpoint, subsequent requests use a
 * shorter budget so the pipeline fast-fails instead of waiting out the
 * full default budget. A single successful request relaxes the endpoint
 * back to the default budget.
 *
 * State is in-memory and tied to the policy instance — Pipeline creates a
 * fresh instance per dataset so one offending dataset doesn’t poison the
 * next.
 *
 * @example
 * ```ts
 * const factory = adaptiveTimeoutPolicy({
 *   default: 300_000,
 *   short: 10_000,
 *   threshold: 2,
 * });
 * ```
 */
export class AdaptiveTimeoutPolicy implements TimeoutPolicy {
  private readonly states = new Map<string, EndpointState>();
  private readonly observers = new Set<TimeoutPolicyObserver>();

  constructor(private readonly options: AdaptiveTimeoutPolicyOptions) {
    if (!Number.isFinite(options.default) || options.default <= 0) {
      throw new Error(
        `AdaptiveTimeoutPolicy: \`default\` must be a positive finite number, received ${options.default}`,
      );
    }
    if (!Number.isFinite(options.short) || options.short <= 0) {
      throw new Error(
        `AdaptiveTimeoutPolicy: \`short\` must be a positive finite number, received ${options.short}`,
      );
    }
    if (!(options.short < options.default)) {
      throw new Error(
        `AdaptiveTimeoutPolicy: \`short\` (${options.short}) must be less than \`default\` (${options.default})`,
      );
    }
    if (!Number.isInteger(options.threshold) || options.threshold < 1) {
      throw new Error(
        `AdaptiveTimeoutPolicy: \`threshold\` must be an integer ≥ 1, received ${options.threshold}`,
      );
    }
  }

  beforeRequest(context: BeforeRequestContext): number {
    const state = this.stateFor(context.endpoint);
    return state.tightened ? this.options.short : this.options.default;
  }

  afterRequest(context: AfterRequestContext): void {
    const state = this.stateFor(context.endpoint);
    if (context.outcome === 'ok') {
      const wasTightened = state.tightened;
      const priorCount = state.consecutiveTimeouts;
      state.consecutiveTimeouts = 0;
      state.tightened = false;
      if (wasTightened) {
        this.notify('relax', {
          endpoint: context.endpoint,
          fromTimeoutMs: this.options.short,
          toTimeoutMs: this.options.default,
          consecutiveTimeouts: priorCount,
        });
      }
      return;
    }
    if (context.outcome === 'timeout') {
      state.consecutiveTimeouts += 1;
      if (
        !state.tightened &&
        state.consecutiveTimeouts >= this.options.threshold
      ) {
        state.tightened = true;
        this.notify('tighten', {
          endpoint: context.endpoint,
          fromTimeoutMs: this.options.default,
          toTimeoutMs: this.options.short,
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
      state = { tightened: false, consecutiveTimeouts: 0 };
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
 * Pass this to {@link PipelineOptions.timeoutPolicy}.
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
 * Pass this to {@link PipelineOptions.timeoutPolicy}; the Pipeline invokes
 * the factory once per dataset so state resets between datasets.
 */
export function adaptiveTimeoutPolicy(
  options: AdaptiveTimeoutPolicyOptions,
): () => AdaptiveTimeoutPolicy {
  // Validate eagerly (see {@link constantTimeoutPolicy}).
   
  new AdaptiveTimeoutPolicy(options);
  return () => new AdaptiveTimeoutPolicy(options);
}
