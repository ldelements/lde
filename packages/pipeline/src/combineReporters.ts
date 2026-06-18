import type { ProgressReporter } from './progressReporter.js';

/** A {@link ProgressReporter} lifecycle method name. */
type ReporterMethod = keyof ProgressReporter;

/** The arguments of a {@link ProgressReporter} method, with its optionality stripped. */
type ReporterArguments<Method extends ReporterMethod> = Parameters<
  NonNullable<ProgressReporter[Method]>
>;

/**
 * Combine several {@link ProgressReporter}s into one that forwards every
 * lifecycle call to each child that implements it. Lets a single run be
 * observed by more than one reporter – e.g. a console reporter alongside a
 * verdict-collecting one.
 *
 * Each method is dispatched to the children in array order; a child that does
 * not implement a given (optional) method is skipped for that call.
 *
 * Internal to the package: not re-exported from `index.ts`. {@link Pipeline}
 * uses it to normalise a `reporter` array into the single reporter its call
 * sites expect, so the broader API need not grow a new public symbol.
 */
export function combineReporters(
  reporters: readonly ProgressReporter[],
): ProgressReporter {
  const forward = <Method extends ReporterMethod>(
    method: Method,
    ...args: ReporterArguments<Method>
  ): void => {
    for (const reporter of reporters) {
      // Cast to the concrete signature for `method`: indexing by a generic key
      // yields a union of method types TS won't call directly, even though the
      // arguments are correlated.
      const handler = reporter[method] as
        | ((...handlerArgs: ReporterArguments<Method>) => void)
        | undefined;
      // Every method is optional; notify only the children that implement it.
      // Invoke through `call` so a class-based reporter keeps its `this`: a bare
      // `handler?.(...)` would drop the receiver and break methods that touch
      // instance state (e.g. ConsoleReporter’s spinner).
      handler?.call(reporter, ...args);
    }
  };

  // Listing every method explicitly (rather than a Proxy) keeps the forwarding
  // type-safe: typing the result as `Required<ProgressReporter>` forces a new
  // entry here whenever the interface grows, so a forgotten method fails to
  // compile instead of silently going unforwarded.
  const combined: Required<ProgressReporter> = {
    pipelineStart: (...args) => forward('pipelineStart', ...args),
    datasetsSelected: (...args) => forward('datasetsSelected', ...args),
    datasetStart: (...args) => forward('datasetStart', ...args),
    distributionProbed: (...args) => forward('distributionProbed', ...args),
    importStarted: (...args) => forward('importStarted', ...args),
    importFailed: (...args) => forward('importFailed', ...args),
    distributionValidated: (...args) =>
      forward('distributionValidated', ...args),
    distributionSelected: (...args) => forward('distributionSelected', ...args),
    stageStart: (...args) => forward('stageStart', ...args),
    stageProgress: (...args) => forward('stageProgress', ...args),
    stageComplete: (...args) => forward('stageComplete', ...args),
    stageFailed: (...args) => forward('stageFailed', ...args),
    stageSkipped: (...args) => forward('stageSkipped', ...args),
    datasetValidated: (...args) => forward('datasetValidated', ...args),
    datasetComplete: (...args) => forward('datasetComplete', ...args),
    datasetSkipped: (...args) => forward('datasetSkipped', ...args),
    pipelineComplete: (...args) => forward('pipelineComplete', ...args),
    timeoutTightened: (...args) => forward('timeoutTightened', ...args),
    timeoutRelaxed: (...args) => forward('timeoutRelaxed', ...args),
  };
  return combined;
}
