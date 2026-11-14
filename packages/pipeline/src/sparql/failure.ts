import isNetworkError from 'is-network-error';
import type { TimeoutOutcome } from './timeoutPolicy.js';

const transientStatusPattern = /HTTP status (\d+)/;

const transientStatuses = new Set<number | undefined>([
  408, 425, 429, 502, 503, 504,
]);

/** The HTTP status `fetch-sparql-endpoint` put in an error’s message. */
export function statusOf(error: Error): number | undefined {
  const match = error.message.match(transientStatusPattern);
  return match ? Number(match[1]) : undefined;
}

/** Whether the endpoint is down or struggling: HTTP 408, 425, 429, 502, 503
 *  or 504, or a network error. */
export function isTransientError(error: unknown): boolean {
  if (isNetworkError(error)) return true;
  if (!(error instanceof Error)) return false;
  const status = statusOf(error);
  return transientStatuses.has(status);
}

/**
 * Classify a fetch error for {@link TimeoutPolicy} reporting.
 *
 * - HTTP 504 → `'timeout'`: the upstream reported it ran out of time. This
 *   is the exact failure mode adaptive timeouts exist to react to.
 * - `AbortError` / `TimeoutError`: our own `AbortSignal.timeout()` fired.
 * - Anything else → `'error'`: neutral with respect to tightening.
 */
export function classifyOutcome(error: unknown): TimeoutOutcome {
  if (error instanceof Error) {
    if (error.name === 'AbortError' || error.name === 'TimeoutError') {
      return 'timeout';
    }
    if (error.cause instanceof Error) {
      if (
        error.cause.name === 'AbortError' ||
        error.cause.name === 'TimeoutError'
      ) {
        return 'timeout';
      }
    }
    if (statusOf(error) === 504) {
      return 'timeout';
    }
  }
  return 'error';
}
