import {
  hostKeyOf,
  mapHostLimited,
  positiveIntOrDefault,
} from '@lde/host-limiter';
import { memoryFactStore } from './memoryFactStore.js';
import type { FactOutcome, FactStore } from './store.js';

/** At most this many resolutions in flight across all hosts. */
const DEFAULT_CONCURRENCY = 4;
/** At most this many in flight against any one host. */
const DEFAULT_PER_HOST_CONCURRENCY = 2;
/** References per outbound call – one, until a source says it takes a list. */
const DEFAULT_BATCH_SIZE = 1;
/** References a single resolver may fetch, so a cold store warms over runs. */
const DEFAULT_FETCHES_PER_RESOLVER = 500;
/** Retries of a failed call, on top of the first attempt. */
const DEFAULT_RETRIES = 2;
/** Delay before the first retry; doubled for each one after it. */
const DEFAULT_RETRY_DELAY_MS = 500;
/** How long one attempt may take before it is abandoned as failed. */
const DEFAULT_TIMEOUT_MS = 30_000;
/** How long an absence is believed when no TTL says otherwise: a week. */
const DEFAULT_ABSENCE_TTL_MS = 7 * 24 * 3_600_000;
/** Consecutive failed batches after which a host is written off. */
const DEFAULT_HOST_FAILURE_THRESHOLD = 5;
/** The version stamped on rows when a caller declares none. */
const DEFAULT_VERSION = '1';
/** Why a key was not fetched when the resolver had already spent its budget. */
const BUDGET_SPENT =
  'this resolver’s fetch budget is spent; construct a resolver per run, or raise fetchesPerResolver';

/**
 * What became of one reference.
 *
 * Three states, because a caller has three moves. `resolved`: use the fact.
 * `absent`: the source answered and has none, which is durable – a record may
 * be indexed as having no such value. `unresolved`: we do not know, because a
 * fetch failed, timed out, was written off with its host, or was never
 * attempted – which must **not** be indexed as an absence, or a passing outage
 * is baked into the index until the next rebuild.
 */
export type Resolution<Fact> =
  | {
      readonly outcome: 'resolved';
      readonly fact: Fact;
      /** When the fact was fetched – this run, or whenever the store got it. */
      readonly fetchedAt: string;
      /** `true` when the fact came from the store rather than the network. */
      readonly fromStore: boolean;
    }
  | {
      readonly outcome: 'absent';
      /** When the source was found to have no fact for this key. */
      readonly fetchedAt: string;
    }
  | { readonly outcome: 'unresolved'; readonly reason: string };

/** One reference that did not resolve freshly, as {@link ResolverOptions.report} sees it. */
export interface ResolutionFailure {
  /** The key of the reference that failed. */
  readonly key: string;
  /** What went wrong, in a form fit to log. */
  readonly reason: string;
  /**
   * Whether a stored fact stood in. `true` is an ageing value and a run that
   * still produced complete output; `false` is a reference the caller has
   * nothing for.
   */
  readonly degradedToStore: boolean;
}

/** The bounds a run resolves within. Every one is optional and defaulted. */
export interface ResolverLimits {
  /** Resolutions in flight across all hosts. Default 4. */
  concurrency?: number;
  /**
   * Resolutions in flight against any one host, so a batch never arrives as
   * the burst that trips a rate limiter. Default 2.
   */
  perHostConcurrency?: number;
  /**
   * References per call to {@link ResolverOptions.fetch}. Default 1 – raise it
   * only for a source that takes a list, where a batch of references is one
   * request. A batch never mixes hosts, so the per-host cap keeps meaning it.
   *
   * Note what it costs: a failing call degrades **every** reference in its
   * batch, so `batchSize` trades throughput against the blast radius of one
   * bad response. The failures are transient and unpersisted – the whole batch
   * is retried next run – but a source that rejects a batch for one malformed
   * member takes the rest of that batch down with it, every run.
   */
  batchSize?: number;
  /**
   * References this **resolver** may fetch over its whole life, refreshes
   * included. Default 500.
   *
   * The point is a cold or purged store: without a cap, the first run after one
   * hands an upstream service the entire backlog at once. With it, the store
   * warms over successive runs and every run still completes – what is not
   * fetched degrades to the stored value, or is reported unresolved.
   *
   * The counter never resets, so **a resolver is a run-scoped object**:
   * construct one, use it, discard it. A resolver kept alive across runs stops
   * fetching when its budget is gone and never starts again.
   *
   * References written off with a failed host cost no outbound call and are
   * refunded, so a dead host cannot spend a budget it never sent a packet for.
   */
  fetchesPerResolver?: number;
  /** Retries of a failed call, on top of the first attempt. Default 2. */
  retries?: number;
  /** Delay before the first retry, doubled for each one after. Default 500. */
  retryDelayMs?: number;
  /**
   * How long one attempt may take before it is abandoned and treated as a
   * failure. Default 30 000.
   *
   * Owned here rather than left to the caller’s client, for the reason the
   * per-host cap is: a client that does not bound this is common, and an
   * unbounded wait is worse than an unbounded request rate – `resolveAll` never
   * settles, so the run hangs with nothing thrown and nothing reported.
   * {@link ResolverOptions.fetch} is handed an `AbortSignal` so it can cancel
   * the underlying request rather than merely being abandoned.
   */
  timeoutMs?: number;
  /**
   * How long a stored fact is served without refetching. Default: forever.
   *
   * A TTL **marks stale, never evicts**. An elapsed one makes the key a
   * candidate for a refresh this run; if the budget or the source denies it,
   * the stored fact is still served. Removing a fact is
   * {@link Resolver.purge}’s job and nothing else’s – the store is the only
   * place the fact lives, so eviction is data loss, not cache management.
   */
  ttlMs?: number;
  /**
   * How long a stored **absence** is believed before the source is asked
   * again. Default: a week, even when {@link ResolverLimits.ttlMs} is unset.
   *
   * An absence is a weaker claim than a fact – it says only that the source had
   * nothing at the time – so it earns a finite default where a fact does not.
   */
  absenceTtlMs?: number;
  /**
   * Consecutive failed batches after which a host is written off for the rest
   * of the resolver’s life. Default 5.
   *
   * The breaker cannot see *why* a batch failed – a source that answers 400 to
   * one malformed IRI throws exactly as a dead host does. At the default
   * `batchSize` of 1 a batch is one reference, so a low threshold lets a couple
   * of bad references in a row write off a host that is perfectly healthy, and
   * a run of 50 000 references then stops resolving after two of them. Five
   * consecutive failures, each already past its retries, is evidence from five
   * different keys; against a genuinely dead host it costs fifteen requests
   * before the breaker saves the rest.
   *
   * Raise it for a source whose per-reference errors are common, lower it for
   * one that only ever fails wholesale. The count is of failures that have
   * *settled*, so up to {@link ResolverLimits.perHostConcurrency} batches may
   * already be in flight when a host is written off; those still run.
   */
  hostFailureThreshold?: number;
}

export interface ResolverOptions<Reference, Fact> {
  /**
   * The key of a reference: what the fact is stored under and what
   * {@link Resolver.resolveAll} answers by. Two references with one key are one
   * unit of work.
   */
  key: (reference: Reference) => string;
  /**
   * Fetch a batch of references, answering with the facts found, by key.
   *
   * A key the source has nothing for is simply **left out** – that is an
   * absence, which is remembered like any other answer, and it is not retried.
   * A **throw** is a failure: the batch is retried with backoff, and if it
   * still throws, every key in it degrades to its stored fact or is reported
   * unresolved. Failures are never remembered, so the next run tries again.
   *
   * Which makes omission the **stronger** claim of the two, and the caller owns
   * it: an absence overwrites a stored fact and is then believed for
   * `absenceTtlMs`, so a source that answers 200 with an empty result while it
   * reindexes will erase what it previously told us. If a source can be empty
   * for reasons other than “no such thing” – an empty page, a maintenance
   * window, a partial response – detect that here and **throw** instead of
   * returning nothing. A failure ages a stored fact; an absence replaces it.
   *
   * `signal` aborts when the attempt outruns
   * {@link ResolverLimits.timeoutMs}; pass it to `fetch()` or your client so
   * the request is cancelled rather than left running.
   */
  fetch: (
    references: readonly Reference[],
    options: { signal: AbortSignal },
  ) => Promise<Iterable<readonly [string, Fact]>>;
  /**
   * The host this resolver contends on: a constant for a single endpoint, or a
   * function when references are fetched from the hosts they name.
   *
   * Required, and deliberately not defaulted to the key’s host. The two differ
   * whenever {@link ResolverOptions.fetch} talks to an aggregator, a proxy or a
   * batching API – then the key names one host and the request goes to another,
   * and a defaulted rule would bound and write off hosts this resolver never
   * contacts while leaving the one it hammers unbounded. Pass {@link urlHost}
   * when the key **is** the URL being fetched.
   */
  host: string | ((reference: Reference) => string);
  /**
   * Where resolved facts live between runs. Defaults to
   * {@link memoryFactStore}, which is to say nothing survives the process –
   * fine for a test, and never what a deployment wants.
   */
  store?: FactStore<Fact>;
  /**
   * The version of the derivation that turns a response into a `Fact`. Default
   * `'1'`.
   *
   * Bump it in the same commit that changes what you derive. A stored row
   * stamped with another version reads as missing and is fetched afresh: the
   * fact is not old, it is the wrong shape, so no TTL can express it and
   * {@link Resolver.purge} would need the caller to enumerate every key. Expect
   * a re-warm to want a raised {@link ResolverLimits.fetchesPerResolver} for a
   * few runs.
   */
  version?: string;
  /** The bounds this resolver works within. */
  limits?: ResolverLimits;
  /**
   * Called once per reference that failed or degraded: a fetch that threw,
   * timed out or was written off with its host. Not called for a key the
   * budget merely deferred – that is the cap working, the caller already learns
   * it from the `unresolved` resolution, and on a cold register-scale store it
   * would be a callback per deferred key.
   *
   * A callback rather than a reporter interface, so this package depends on
   * nothing that knows what a pipeline is.
   */
  report?: (failure: ResolutionFailure) => void;
  /**
   * The clock, for `fetchedAt` and for staleness. Injected so a test can age a
   * stored fact without waiting for it.
   */
  now?: () => Date;
}

export interface Resolver<Reference, Fact> {
  /**
   * Resolve these references, answering with one {@link Resolution} per
   * distinct key.
   *
   * Memory is bounded by what the caller passes: the resolver holds the batch,
   * its stored facts and its results, and nothing beyond them. A caller with
   * more references than it can hold passes them a batch at a time – the store
   * carries what the previous batch learned, so batching costs nothing but the
   * first run’s requests.
   *
   * Fresh work is spent where it counts: a key with no stored row is fetched
   * before one that is merely stale, because a missing fact costs the caller a
   * value while a stale one only ages it.
   */
  resolveAll(
    references: readonly Reference[],
  ): Promise<Map<string, Resolution<Fact>>>;
  /** Verify the store can persist facts, throwing when it cannot. */
  check(): Promise<void>;
  /**
   * Forget these keys, so the next run resolves them afresh. The one answer to
   * a fact that turned out wrong: nothing revalidates, so nothing else can
   * notice.
   */
  purge(keys: readonly string[]): Promise<void>;
}

/**
 * The host of a key that is itself the URL being fetched – for
 * {@link ResolverOptions.host}, when reference, key and request all name the
 * same origin.
 *
 * Falls back to the key itself when it does not parse as a URL, so an opaque
 * key space gets a budget per key rather than one shared bucket that would
 * serialize everything.
 */
export function urlHost(key: string): string {
  try {
    return hostKeyOf(new URL(key));
  } catch {
    return key;
  }
}

/**
 * Build a {@link Resolver}: everything around fetching a fact from outside the
 * graph, so a caller writes only the fetch and what to do with the answer.
 *
 * *Transforms rewrite what the graph said; resolvers fetch what it only pointed
 * at.* This package knows references, keys and facts – not quads, documents,
 * stages or pipelines – so a pipeline calls it from inside a transform, and
 * anything else calls it from anywhere.
 *
 * ```ts
 * const resolver = createResolver({
 *   key: (iri: string) => iri,
 *   host: 'termennetwerk-api.netwerkdigitaalerfgoed.nl',
 *   fetch: async (iris, { signal }) =>
 *     (await lookup(iris, { signal })).map((term) => [term.uri, coordinatesOf(term)]),
 *   store: sqliteFactStore({ path: '/data/terms.sqlite' }),
 *   version: '1',
 *   limits: { batchSize: 25, fetchesPerResolver: 5_000, ttlMs: 30 * 24 * 3_600_000 },
 *   report: (failure) => console.warn(failure.key, failure.reason),
 * });
 *
 * const resolved = await resolver.resolveAll(iris);
 * ```
 */
export function createResolver<Reference, Fact>(
  options: ResolverOptions<Reference, Fact>,
): Resolver<Reference, Fact> {
  const store = options.store ?? memoryFactStore<Fact>();
  const now = options.now ?? (() => new Date());
  const version = options.version ?? DEFAULT_VERSION;
  const limits = options.limits ?? {};
  const concurrency = positiveIntOrDefault(
    limits.concurrency,
    DEFAULT_CONCURRENCY,
  );
  const perHostConcurrency = positiveIntOrDefault(
    limits.perHostConcurrency,
    DEFAULT_PER_HOST_CONCURRENCY,
  );
  const batchSize = positiveIntOrDefault(limits.batchSize, DEFAULT_BATCH_SIZE);
  const retries = nonNegativeIntOrDefault(limits.retries, DEFAULT_RETRIES);
  const retryDelayMs = nonNegativeIntOrDefault(
    limits.retryDelayMs,
    DEFAULT_RETRY_DELAY_MS,
  );
  const timeoutMs = positiveIntOrDefault(limits.timeoutMs, DEFAULT_TIMEOUT_MS);
  const ttlMs = limits.ttlMs;
  const absenceTtlMs = positiveIntOrDefault(
    limits.absenceTtlMs,
    DEFAULT_ABSENCE_TTL_MS,
  );
  const hostFailureThreshold = positiveIntOrDefault(
    limits.hostFailureThreshold,
    DEFAULT_HOST_FAILURE_THRESHOLD,
  );
  // The budget spans the resolver, not one resolveAll: a caller passing many
  // batches is one run, and the cap exists to bound the run.
  let fetchesLeft = positiveIntOrDefault(
    limits.fetchesPerResolver,
    DEFAULT_FETCHES_PER_RESOLVER,
  );
  // Hosts written off for the rest of this resolver’s life, and the consecutive
  // failures each has to its name. Kept per resolver rather than per call: a
  // host down at the start of a run is down forty minutes later, and re-probing
  // it once per passed batch would be the stampede this exists to stop.
  const consecutiveFailures = new Map<string, number>();
  const writtenOff = new Set<string>();

  const hostOf =
    typeof options.host === 'string'
      ? () => options.host as string
      : options.host;

  return {
    check: async () => store.check?.(),
    purge: (keys) => store.purge(keys),

    async resolveAll(references) {
      // One unit of work per key: two references sharing a key are one fetch
      // and one answer.
      const byKey = new Map<string, Keyed<Reference>>();
      for (const reference of references) {
        const key = options.key(reference);
        if (!byKey.has(key)) {
          byKey.set(key, { key, reference });
        }
      }
      const keys = [...byKey.keys()];
      const stored = await store.get(keys);

      const missing: Keyed<Reference>[] = [];
      const stale: Keyed<Reference>[] = [];
      const at = now();
      for (const entry of byKey.values()) {
        const held = stored.get(entry.key);
        // A row from another version is not old, it is the wrong shape: treat
        // it as nothing at all rather than serving or ageing it.
        if (held === undefined || held.version !== version) {
          missing.push(entry);
        } else if (
          isStale(
            held.fetchedAt,
            held.status === 'absent' ? absenceTtlMs : ttlMs,
            at,
          )
        ) {
          stale.push(entry);
        }
      }
      // Missing first: a key with nothing stored costs the caller a value,
      // where a stale one only ages. Within each group, input order.
      let queued: Keyed<Reference>[] = [...missing, ...stale];
      const fetched = new Map<string, FetchOutcome<Fact>>();
      // Spend, then re-spend what came back. A reference written off with a
      // dead host sends nothing, so its budget is refunded – and the refund has
      // to be usable *here*, or one dead host denies live hosts the allowance
      // it never spent and answers them with a budget that was handed straight
      // back. Each pass takes at least one reference, so this terminates.
      while (queued.length > 0 && fetchesLeft > 0) {
        const affordable = queued.slice(0, fetchesLeft);
        queued = queued.slice(affordable.length);
        fetchesLeft -= affordable.length;

        const pass = await fetchInBatches(affordable);
        for (const [key, outcome] of pass.outcomes) {
          fetched.set(key, outcome);
        }
        fetchesLeft += pass.skipped;
        if (pass.skipped === 0) {
          break; // Nothing refunded, so nothing more is affordable.
        }
      }

      const resolutions = new Map<string, Resolution<Fact>>();
      const learned = new Map<string, FactOutcome<Fact>>();
      const fetchedAt = now().toISOString();

      for (const key of keys) {
        const outcome = fetched.get(key);
        if (outcome?.kind === 'present') {
          learned.set(key, { status: 'present', fact: outcome.fact });
          resolutions.set(key, {
            outcome: 'resolved',
            fact: outcome.fact,
            fetchedAt,
            fromStore: false,
          });
          continue;
        }
        if (outcome?.kind === 'absent') {
          // The source answered and has nothing. Remember it, or every run
          // spends its budget asking a question already answered.
          learned.set(key, { status: 'absent' });
          resolutions.set(key, { outcome: 'absent', fetchedAt });
          continue;
        }
        // Not answered freshly – because it was not tried (served from the
        // store, denied by the budget, or written off with its host), or
        // because the attempt failed.
        const held = stored.get(key);
        const usable = held !== undefined && held.version === version;
        if (usable && held.status === 'present') {
          resolutions.set(key, {
            outcome: 'resolved',
            fact: held.fact,
            fetchedAt: held.fetchedAt,
            fromStore: true,
          });
          // Serving a fact that was never up for refresh is the store doing its
          // job, not a failure: report only when a fetch actually failed.
          if (outcome !== undefined) {
            options.report?.({
              key,
              reason: outcome.reason,
              degradedToStore: true,
            });
          }
          continue;
        }
        if (usable && held.status === 'absent') {
          resolutions.set(key, {
            outcome: 'absent',
            fetchedAt: held.fetchedAt,
          });
          if (outcome !== undefined) {
            options.report?.({
              key,
              reason: outcome.reason,
              degradedToStore: true,
            });
          }
          continue;
        }
        // Nothing usable stored: the key was wanted, and either failed or was
        // never attempted.
        if (outcome !== undefined) {
          resolutions.set(key, {
            outcome: 'unresolved',
            reason: outcome.reason,
          });
          options.report?.({
            key,
            reason: outcome.reason,
            degradedToStore: false,
          });
          continue;
        }
        // Deferred by the budget – the only way left to arrive here, since a
        // key with nothing usable stored is always wanted, and a wanted key is
        // either fetched (an outcome above) or denied. Not a failure, so not
        // reported: the caller is holding the answer already.
        resolutions.set(key, { outcome: 'unresolved', reason: BUDGET_SPENT });
      }

      // Persist before answering, so a caller that crashes applying the facts
      // does not re-fetch them next run.
      await store.set(learned, fetchedAt, version);
      return resolutions;
    },
  };

  /**
   * Fetch the wanted references in host-homogeneous batches, under both caps,
   * and answer per key: the fact, the absence, or why there is neither. Also
   * answers how many references were written off with a failed host, which
   * their caller refunds – they cost no outbound call.
   */
  async function fetchInBatches(wanted: readonly Keyed<Reference>[]): Promise<{
    outcomes: Map<string, FetchOutcome<Fact>>;
    skipped: number;
  }> {
    const outcomes = new Map<string, FetchOutcome<Fact>>();
    // Group by host first, so a batch never mixes hosts – a mixed batch would
    // make the per-host cap a fiction, since one call would touch two hosts.
    const byHost = new Map<string, Keyed<Reference>[]>();
    for (const entry of wanted) {
      const host = hostOf(entry.reference);
      const group = byHost.get(host);
      if (group === undefined) {
        byHost.set(host, [entry]);
      } else {
        group.push(entry);
      }
    }
    const batches: Array<{ host: string; entries: Keyed<Reference>[] }> = [];
    for (const [host, group] of byHost) {
      for (let start = 0; start < group.length; start += batchSize) {
        batches.push({ host, entries: group.slice(start, start + batchSize) });
      }
    }

    let skipped = 0;
    const results = await mapHostLimited(
      batches,
      batches.map((batch) => batch.host),
      concurrency,
      perHostConcurrency,
      async (batch) => {
        if (writtenOff.has(batch.host)) {
          // The host has already failed its way out of this run. Answering
          // without a request is the whole point: retrying every reference
          // against a host that is down is the stampede, not the remedy.
          skipped += batch.entries.length;
          return batch.entries.map(
            ({ key }) =>
              [
                key,
                {
                  kind: 'failed',
                  reason: `host ${batch.host} was written off after ${hostFailureThreshold} consecutive failures; not contacted again this run`,
                },
              ] as const,
          );
        }
        const answered = await attempt(batch.entries);
        noteHostOutcome(
          batch.host,
          answered.some(([, outcome]) => outcome.kind !== 'failed'),
        );
        return answered;
      },
    );
    for (const result of results) {
      for (const [key, outcome] of result) {
        outcomes.set(key, outcome);
      }
    }
    return { outcomes, skipped };
  }

  /**
   * Count a host’s consecutive failures and write it off once they reach the
   * threshold. Any success clears the count: the breaker is for a host that is
   * down, not for one that is merely imperfect.
   */
  function noteHostOutcome(host: string, succeeded: boolean): void {
    if (succeeded) {
      consecutiveFailures.delete(host);
      return;
    }
    const failures = (consecutiveFailures.get(host) ?? 0) + 1;
    consecutiveFailures.set(host, failures);
    if (failures >= hostFailureThreshold) {
      writtenOff.add(host);
    }
  }

  /**
   * One batch, bounded in time, retried with doubling backoff, and isolated
   * from every other batch: a throw becomes a per-key reason rather than a
   * rejection, so one failing call degrades its own references and nothing
   * else.
   */
  async function attempt(
    entries: readonly Keyed<Reference>[],
  ): Promise<Array<readonly [string, FetchOutcome<Fact>]>> {
    const references = entries.map((entry) => entry.reference);
    for (let attemptIndex = 0; ; attemptIndex++) {
      try {
        const found = new Map(await fetchWithin(references));
        return entries.map(({ key }) => {
          const fact = found.get(key);
          return [
            key,
            fact === undefined
              ? ({ kind: 'absent' } as const)
              : ({ kind: 'present', fact } as const),
          ] as const;
        });
      } catch (error) {
        if (attemptIndex >= retries) {
          const reason = `resolution failed after ${attemptIndex + 1} attempt(s): ${describe(error)}`;
          return entries.map(
            ({ key }) => [key, { kind: 'failed', reason }] as const,
          );
        }
        await delay(retryDelayMs * 2 ** attemptIndex);
      }
    }
  }

  /**
   * One attempt, abandoned as a failure when it outruns the timeout. The signal
   * is handed to `fetch` so a caller can cancel the request rather than being
   * left running behind an answer nobody waits for.
   */
  async function fetchWithin(
    references: readonly Reference[],
  ): Promise<Iterable<readonly [string, Fact]>> {
    const controller = new AbortController();
    const expiry = setTimeout(() => controller.abort(), timeoutMs);
    try {
      return await Promise.race([
        options.fetch(references, { signal: controller.signal }),
        rejectWhenAborted<Iterable<readonly [string, Fact]>>(
          controller.signal,
          timeoutMs,
        ),
      ]);
    } finally {
      clearTimeout(expiry);
    }
  }
}

/** Reject as soon as the attempt’s deadline passes, whatever `fetch` is doing. */
function rejectWhenAborted<T>(
  signal: AbortSignal,
  timeoutMs: number,
): Promise<T> {
  return new Promise<T>((_resolve, reject) => {
    signal.addEventListener(
      'abort',
      () => reject(new Error(`timed out after ${timeoutMs}ms`)),
      { once: true },
    );
  });
}

/** A reference under the key it resolves as. */
interface Keyed<Reference> {
  readonly key: string;
  readonly reference: Reference;
}

/** What a fetch made of a key: a fact, an absence, or a failure. */
type FetchOutcome<Fact> =
  | { readonly kind: 'present'; readonly fact: Fact }
  | { readonly kind: 'absent' }
  | { readonly kind: 'failed'; readonly reason: string };

/** Whether a stored row has outlived its TTL. No TTL means never. */
function isStale(
  fetchedAt: string,
  ttlMs: number | undefined,
  at: Date,
): boolean {
  if (ttlMs === undefined) {
    return false;
  }
  const stampedAt = Date.parse(fetchedAt);
  // An unparseable stamp is treated as stale: something wrote it, we cannot
  // tell how long ago, and refetching is the recoverable answer.
  return Number.isNaN(stampedAt) || at.getTime() - stampedAt > ttlMs;
}

/** Coerce a count that may legitimately be zero – retries, delays. */
function nonNegativeIntOrDefault(
  value: number | undefined,
  fallback: number,
): number {
  return value !== undefined && Number.isInteger(value) && value >= 0
    ? value
    : fallback;
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}
