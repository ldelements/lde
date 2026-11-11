/**
 * Read an HTTP `Retry-After` header as milliseconds to wait – how long to
 * {@link HostLimiter.pause} a host, or `@lde/resolver`’s `RetryableError`
 * `retryAfterMs`.
 *
 * Takes both forms the header comes in: a number of seconds, or an HTTP date –
 * read as the time left until it. Answers `undefined` for a missing or
 * unreadable header, and for one that asks for no wait at all – `0`, or a date
 * already past – so the caller falls back to its own backoff rather than
 * retrying back to back.
 *
 * ```ts
 * if (response.status === 503) {
 *   const retryAfterMs = parseRetryAfter(response.headers.get('retry-after'));
 *   limiter.pause(host, Date.now() + (retryAfterMs ?? 5_000));
 * }
 * ```
 */
export function parseRetryAfter(
  value: string | null | undefined,
  now: Date = new Date(),
): number | undefined {
  const trimmed = value?.trim();
  if (trimmed === undefined || trimmed === '') {
    return undefined;
  }
  if (/^\d+$/.test(trimmed)) {
    return Number(trimmed) * 1000 || undefined;
  }
  // An HTTP date always names its day, which keeps a bare signed number such as
  // `-5` from being read as a year.
  if (!/[a-z]/i.test(trimmed)) {
    return undefined;
  }
  const at = Date.parse(trimmed);
  const waitMs = at - now.getTime();
  return waitMs > 0 ? waitMs : undefined;
}
