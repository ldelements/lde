// Registered symbols, so every copy of this package brands with the same key.
const REFERENCE_FAILURE = Symbol.for('@lde/resolver.ReferenceFailure');
const RETRYABLE_ERROR = Symbol.for('@lde/resolver.RetryableError');

/**
 * One reference the source failed on, while the call itself went fine – a
 * document that will not parse, a 500 on one image among many that load. Made
 * by {@link referenceFailure}.
 */
export class ReferenceFailure {
  /**
   * Recognised by brand rather than prototype, so a failure made by another
   * copy of this package – a pruned or nested install loads it twice – is never
   * stored as a fact.
   */
  static [Symbol.hasInstance](value: unknown): value is ReferenceFailure {
    return hasBrand(value, REFERENCE_FAILURE);
  }

  readonly [REFERENCE_FAILURE] = true;

  /** @internal Use {@link referenceFailure}. */
  constructor(
    /** Why this reference failed, in a form fit to log. */
    readonly reason: string,
  ) {}
}

/**
 * Mark one reference as failed, in place of its fact in the answer from
 * {@link ResolverOptions.fetch}: `[key, referenceFailure('not a manifest')]`.
 *
 * For a failure that belongs to the reference, not to the host. It is not
 * retried this run, is not stored, keeps a stored fact if there is one and is
 * otherwise `unresolved`, is reported, and never counts towards writing the host
 * off – so other references on a healthy host keep resolving. The next run
 * asks again.
 *
 * Use it rather than leaving the key out, which is an absence and overwrites a
 * stored fact; and rather than throwing, which fails the whole batch and counts
 * against the host.
 */
export function referenceFailure(reason: string): ReferenceFailure {
  return new ReferenceFailure(reason);
}

/**
 * Read an HTTP `Retry-After` header as milliseconds to wait, for
 * {@link RetryableError}’s `retryAfterMs`.
 *
 * Takes both forms the header comes in: a number of seconds, or an HTTP date –
 * read as the time left until it, and as no wait when it is already past.
 * Answers `undefined` for a missing or unreadable header, so the resolver falls
 * back to its own backoff.
 *
 * ```ts
 * if (response.status === 429) {
 *   throw new RetryableError('HTTP 429', {
 *     retryAfterMs: parseRetryAfter(response.headers.get('retry-after')),
 *   });
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
    return Number(trimmed) * 1000;
  }
  // An HTTP date always names its day, which keeps a bare signed number such as
  // `-5` from being read as a year.
  if (!/[a-z]/i.test(trimmed)) {
    return undefined;
  }
  const at = Date.parse(trimmed);
  return Number.isNaN(at) ? undefined : Math.max(0, at - now.getTime());
}

/**
 * Thrown from {@link ResolverOptions.fetch} when the source said to come back
 * later – a 429, or a 503 with `Retry-After` – so a retry within the run is
 * likely to succeed.
 *
 * Only this is retried in the run, at most twice; any other throw fails the
 * call until the next run. With `retryAfterMs` the source sets the delay, and
 * the whole host waits it out: a rate limit is about this client, not about one
 * reference. Without it the resolver backs off by itself, 500 ms and then 1 s.
 * A delay longer than {@link ResolverLimits.timeoutMs} is not waited out; the
 * call fails for this run instead.
 */
export class RetryableError extends Error {
  /** Recognised by brand, for the reason {@link ReferenceFailure} is. */
  static override [Symbol.hasInstance](
    value: unknown,
  ): value is RetryableError {
    return hasBrand(value, RETRYABLE_ERROR);
  }

  readonly [RETRYABLE_ERROR] = true;

  /** How long the source asked us to wait, when it said; see {@link parseRetryAfter}. */
  readonly retryAfterMs?: number;

  constructor(
    message: string,
    options: { retryAfterMs?: number; cause?: unknown } = {},
  ) {
    super(message, { cause: options.cause });
    this.name = 'RetryableError';
    this.retryAfterMs = options.retryAfterMs;
  }
}

function hasBrand(value: unknown, brand: symbol): boolean {
  return typeof value === 'object' && value !== null && brand in value;
}
