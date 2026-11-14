import { SparqlEndpointFetcher } from 'fetch-sparql-endpoint';
import { parseRetryAfter, type HostLimiter } from '@lde/host-limiter';
import { classifyOutcome, isTransientError } from './failure.js';

/** What a query’s response said beyond its status. */
export interface ResponseNotes {
  retryAfterMs?: number;
}

/**
 * Run a query on the limiter under `key`, pausing the endpoint and trying
 * again while it is down, struggling or throttling ({@link isTransientError}):
 * 5, 15, 45, 135 and 405 s, or what `Retry-After` asks, failing at once when
 * that is longer than the longest step. A transient failure or a timeout
 * lowers the limit; any other failure leaves it alone.
 *
 * `query` is called once per attempt, with the notes its fetcher should fill
 * in ({@link fetcherNotingRetryAfter}).
 */
export async function runWithRetries<Result>(
  limiter: HostLimiter,
  key: string,
  query: (response: ResponseNotes) => Promise<Result>,
): Promise<Result> {
  for (let retry = 0; ; retry++) {
    const response: ResponseNotes = {};
    const willRetry = (error: unknown) =>
      isTransientError(error) &&
      retry < BACKOFF_MS.length &&
      !asksToWaitTooLong(response);
    try {
      return await limiter.run(key, async (slot) => {
        try {
          return await query(response);
        } catch (error) {
          // A rejection lowers the limit, unless the slot is told otherwise.
          if (isTransientError(error)) {
            // Paused before the slot frees, so no query waiting for it goes
            // out to an endpoint that is down.
            if (willRetry(error)) {
              limiter.pause(
                key,
                Date.now() + backoffMs(retry, response.retryAfterMs),
              );
            }
          } else if (classifyOutcome(error) !== 'timeout') {
            slot.ignore();
          }
          throw error;
        }
      });
    } catch (error) {
      if (!willRetry(error)) {
        throw error;
      }
    }
  }
}

/**
 * A {@link SparqlEndpointFetcher} for one attempt, with the attempt’s timeout
 * baked in, that notes a failed response’s `Retry-After` in `response`.
 */
export function fetcherNotingRetryAfter(
  timeoutMs: number,
  response: ResponseNotes,
): SparqlEndpointFetcher {
  return new SparqlEndpointFetcher({
    timeout: timeoutMs,
    fetch: async (input, init) => {
      const answer = await fetch(input, init);
      if (!answer.ok) {
        response.retryAfterMs = parseRetryAfter(
          answer.headers.get('retry-after'),
        );
      }
      return answer;
    },
  });
}

/**
 * How long to pause the endpoint before each retry after it went down, in
 * milliseconds: tripled each time, about 10 minutes in all, to outlast a
 * backend restart. A `Retry-After` header replaces a step.
 */
const BACKOFF_MS = [5_000, 15_000, 45_000, 135_000, 405_000];

/**
 * How long to pause before retry `retry`: what `Retry-After` asked, or the
 * step itself when the endpoint did not say.
 */
function backoffMs(retry: number, retryAfterMs: number | undefined): number {
  return retryAfterMs ?? BACKOFF_MS[retry];
}

/**
 * Whether the endpoint asked to be left alone for longer than the longest
 * step, such as a rate limit’s hourly quota: the query fails at once rather
 * than ask again before the endpoint said it would answer.
 */
function asksToWaitTooLong(response: ResponseNotes): boolean {
  return (
    response.retryAfterMs !== undefined &&
    response.retryAfterMs > BACKOFF_MS[BACKOFF_MS.length - 1]
  );
}
