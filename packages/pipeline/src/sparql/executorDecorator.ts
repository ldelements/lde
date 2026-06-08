import type { Executor } from './executor.js';

/**
 * Wraps an {@link Executor} to augment its behaviour.
 *
 * A decorator receives the inner executor it wraps and returns a new executor.
 * It never reads the underlying query — its capabilities are the inner
 * executor plus the {@link Dataset}/{@link Distribution}/{@link ExecuteOptions}
 * handed to `execute()` at call time. That `Distribution` is what gives a
 * decorator reach beyond a plain quad transform: it can fire its own queries
 * against the dataset endpoint, honour the named graph and subject filter, and
 * thread the per-call {@link TimeoutPolicy} through.
 *
 * **Scope contract.** A decorator wraps a single `execute()` call. For a global
 * (non-per-class) stage that one call yields the whole stage output, so the
 * decorator sees the complete result set — the aggregation window needed to,
 * for example, pick the single most common namespace. For a per-class stage
 * each call covers one batch of class bindings, so a decorator there sees only
 * that batch. Per-class decoration is permitted but caveated: aggregate across
 * the whole dataset only in a global stage.
 *
 * The framework hands the decorator its capabilities; it does not police what
 * the decorator emits. A decorator may pass the inner output through and append
 * (additive, like the vocabulary detector) or replace it entirely (like the URI
 * space aggregator).
 */
export type ExecutorDecorator = (inner: Executor) => Executor;

/**
 * Fold several {@link ExecutorDecorator}s into one, applied innermost-first.
 *
 * Decorators are applied left to right, so the first argument wraps the base
 * executor and each later decorator wraps the result of the previous one. The
 * last argument therefore ends up outermost. This makes the composition order
 * explicit and well-defined: a consumer decorator passed after a built-in one
 * wraps the built-in rather than silently clobbering it.
 *
 * `undefined` entries are skipped, so optional decorators can be passed
 * straight through without guarding each one at the call site.
 *
 * @example
 * ```typescript
 * // base → built-in → consumer (consumer outermost)
 * const decorate = composeDecorators(builtIn, consumer);
 * const executor = decorate(new SparqlConstructExecutor({ query }));
 * ```
 */
export function composeDecorators(
  ...decorators: (ExecutorDecorator | undefined)[]
): ExecutorDecorator {
  return (inner) =>
    decorators.reduce<Executor>(
      (executor, decorate) => (decorate ? decorate(executor) : executor),
      inner,
    );
}
