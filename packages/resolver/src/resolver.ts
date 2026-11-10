import {
  createHostLimiter,
  hostKeyOf,
  positiveIntOrDefault,
  type HostLimiter,
} from '@lde/host-limiter';
import { ReferenceFailure, RetryableError } from './failures.js';
import { memoryFactStore } from './memoryFactStore.js';
import type { FactOutcome, FactStore } from './store.js';

/** The caps of the limiter a resolver builds when it is given none. */
const DEFAULT_CONCURRENCY = 4;
/** References per outbound call – one, until a source says it takes a list. */
const DEFAULT_BATCH_SIZE = 1;
/** References a single resolver may fetch, so a cold store warms over runs. */
const DEFAULT_FETCHES_PER_RESOLVER = 500;
/** Retries of a {@link RetryableError}, on top of the first attempt. */
const RETRIES = 2;
/** Delay before the first such retry when the source names none; doubled after. */
const RETRY_DELAY_MS = 500;
/** How long one attempt may take before it is abandoned as failed. */
const DEFAULT_TIMEOUT_MS = 10_000;
/** How long an absence is believed when no TTL says otherwise: a week. */
const DEFAULT_ABSENCE_TTL_MS = 7 * 24 * 3_600_000;
/** Failed batches, among a host’s last twice as many, that write it off. */
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

/**
 * What {@link ResolveOptions.count} is called with, once per distinct key:
 * `fetched` or `absent` when the source answered this run, `from store` when
 * the store answered and the key was not due a fetch, `failed` when a fetch
 * failed, `written off` when the key’s host had already failed its way out of
 * the run, and `deferred` when the key was due a fetch but the budget was
 * spent. A stored fact may still stand in for the last three.
 */
export type ResolutionCount =
  'fetched' | 'absent' | 'from store' | 'failed' | 'written off' | 'deferred';

/** Options for one {@link Resolver.resolveAll} call. */
export interface ResolveOptions {
  /**
   * Called once per distinct key with what became of it, so a caller can add
   * up a run – a pipeline transform passes its `context.count`.
   */
  count?: (name: ResolutionCount) => void;
}

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
  /**
   * References per call to {@link ResolverOptions.fetch}. Default 1 – raise it
   * only for a source that takes a list, where a batch of references is one
   * request. A batch never mixes hosts, so the per-host limit keeps meaning it.
   *
   * Note what it costs: a failing call degrades **every** reference in its
   * batch, so `batchSize` trades throughput against the blast radius of one
   * bad response. The failures are transient and unpersisted – the whole batch
   * is retried next run – but a source that rejects a batch for one malformed
   * member takes the rest of that batch down with it, every run. Answer a
   * {@link referenceFailure} for that member instead of throwing.
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
   * The budget counts references, not requests: a second attempt after a
   * timeout, or a retry the source asked for, costs nothing more.
   */
  fetchesPerResolver?: number;
  /**
   * How long one attempt may take before it is abandoned and treated as a
   * failure. Default 10 000 – six times what a slow IIIF manifest took when
   * measured, and what `ky` and OkHttp default to.
   *
   * It bounds a whole call to {@link ResolverOptions.fetch}, so a caller with a
   * large {@link ResolverLimits.batchSize} may need to raise it. A timed-out
   * reference queues again behind the batches waiting for its host, for one
   * more attempt in case the stall has passed; a second timeout fails it for
   * this run.
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
   * Failed batches, among a host’s last `2 × hostFailureThreshold`, after which
   * the host is written off for the rest of the resolver’s life. Default 5, so
   * 5 of the last 10.
   *
   * **A burst of failures counts once.** When a host goes down, every batch in
   * flight fails together, so a failure counts only if none of the host’s
   * failures was counted after its batch started. One bad moment at a high
   * limit therefore costs one failure, and halves the host’s limit in
   * {@link ResolverOptions.limiter}; a host that keeps failing, burst after
   * burst, is written off.
   *
   * A window rather than a run of consecutive failures, so a host where most
   * references fail is written off even when a few succeed in between. A dead
   * host costs the threshold in batches before the breaker saves the rest, plus
   * whatever was already in flight (see below).
   *
   * Only **systemic** failures count – a throw from
   * {@link ResolverOptions.fetch}, after any retry. A timeout or broken
   * connection counts when it first fails, not after its second attempt, so a
   * host that times out on everything is written off without every reference
   * paying a timeout first. A second attempt that is answered takes that
   * failure back, so a host that recovers from a slow moment is not written
   * off; one that fails is not counted again. A batch
   * whose every key came back as a {@link referenceFailure} does not enter the
   * window at all, so broken references never write off a host whose other
   * references resolve. A batch with at least one fact or absence counts as a
   * success.
   *
   * Batches of the burst that writes a host off, already in flight then,
   * still run.
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
   * Four answers per key, and the caller picks the one that says what went
   * wrong, because only the caller sees the response:
   *
   * - **A fact.** Stored and served.
   * - **Left out.** An absence, remembered like any other answer and not
   *   retried.
   * - **`[key, referenceFailure(reason)]`.** This reference failed while the
   *   call went fine – a document that will not parse, a 500 on one image among
   *   many. Not retried this run, never held against the host.
   * - **A throw.** The call failed: every key in the batch degrades to its
   *   stored fact or is reported unresolved, and the failure counts towards
   *   writing the host off. It is not retried this run, with two exceptions.
   *   Throw a {@link RetryableError} when the source said to come back later –
   *   a 429, a 503 with `Retry-After` – and it is retried at most twice. And a
   *   timeout or a broken connection gets one more attempt, queued behind the
   *   batches waiting for its host: the resolver’s own timeout, or one of the codes
   *   `ECONNRESET`, `ECONNREFUSED`, `ETIMEDOUT`, `EAI_AGAIN`, `UND_ERR_SOCKET`
   *   or `UND_ERR_CONNECT_TIMEOUT` on the error or its `cause`, where Node’s
   *   `fetch` puts it. Such an error needs no wrapping.
   *
   * Failures of either kind are never remembered, so the next run tries again.
   *
   * Which makes omission the **stronger** claim, and the caller owns
   * it: an absence overwrites a stored fact and is then believed for
   * `absenceTtlMs`, so a source that answers 200 with an empty result while it
   * reindexes will erase what it previously told us. If a source can be empty
   * for reasons other than “no such thing” – an empty page, a maintenance
   * window, a partial response – detect that here and **throw**, or answer a
   * {@link referenceFailure} for the one key, instead of returning nothing. A
   * failure ages a stored fact; an absence replaces it.
   *
   * `signal` aborts when the attempt outruns
   * {@link ResolverLimits.timeoutMs}; pass it to `fetch()` or your client so
   * the request is cancelled rather than left running.
   *
   * Do not await `resolveAll` on the same resolver from here: an attempt holds
   * its concurrency slot while it runs, so the nested call can wait on a slot
   * only the attempt can free, and the attempt then fails on its timeout.
   */
  fetch: (
    references: readonly Reference[],
    options: { signal: AbortSignal },
  ) => Promise<Iterable<readonly [string, Fact | ReferenceFailure]>>;
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
   * The concurrency limits this resolver’s batches run under, keyed by
   * {@link ResolverOptions.host}. Default: a limiter of its own, with at most
   * 4 batches in flight and at most 4 against any one host.
   *
   * Each host’s limit adapts: it starts at one batch in flight and rises while
   * the host keeps up. A throw from {@link ResolverOptions.fetch} counts as
   * overload and halves it; an answer, a {@link referenceFailure} included, does
   * not. A {@link RetryableError} with a delay pauses the host for that long.
   *
   * Pass one limiter to every resolver that loads the same backend, with host
   * keys that name that backend, so their limits are one: a backend slowed down
   * by one of them is slowed down for all.
   */
  limiter?: HostLimiter;
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
    options?: ResolveOptions,
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
  // At least one limiter per resolver, for the reason the budget below is: a
  // stage calls resolveAll from batches running in parallel, and the caps bound
  // them together.
  const limiter =
    options.limiter ??
    createHostLimiter(DEFAULT_CONCURRENCY, DEFAULT_CONCURRENCY);
  const batchSize = positiveIntOrDefault(limits.batchSize, DEFAULT_BATCH_SIZE);
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
  // How many of a host’s latest batches the breaker looks at.
  const failureWindow = 2 * hostFailureThreshold;
  // The budget spans the resolver, not one resolveAll: a caller passing many
  // batches is one run, and the cap exists to bound the run.
  let fetchesLeft = positiveIntOrDefault(
    limits.fetchesPerResolver,
    DEFAULT_FETCHES_PER_RESOLVER,
  );
  // Hosts written off for the rest of this resolver’s life, and whether each of
  // a host’s recent batches failed, newest last – at most
  // `2 × hostFailureThreshold` of them. Kept per resolver rather than per call:
  // a host down at the start of a run is down forty minutes later, and
  // re-probing it once per passed batch would be the stampede this exists to
  // stop.
  const recentFailures = new Map<string, boolean[]>();
  const writtenOff = new Set<string>();
  // Orders attempts and counted failures, so a failure can tell whether one of
  // its host’s failures was counted after its own attempt started; kept per
  // host only while the host has a failure in its window.
  let tick = 0;
  const lastCountedAt = new Map<string, number>();

  const hostOf =
    typeof options.host === 'string'
      ? () => options.host as string
      : options.host;

  return {
    check: async () => store.check?.(),
    purge: (keys) => store.purge(keys),

    async resolveAll(references, resolveOptions) {
      const count = resolveOptions?.count ?? (() => undefined);
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
      // Due a fetch, but the budget ran out before it was sent.
      const deferred = new Set(queued.map(({ key }) => key));

      const resolutions = new Map<string, Resolution<Fact>>();
      const learned = new Map<string, FactOutcome<Fact>>();
      const fetchedAt = now().toISOString();

      for (const key of keys) {
        const outcome = fetched.get(key);
        count(countOf(outcome, deferred.has(key)));
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
    const results = await Promise.all(batches.map(runBatch));
    for (const answered of results) {
      for (const [key, outcome] of answered) {
        outcomes.set(key, outcome);
      }
    }
    return { outcomes, skipped };

    /**
     * One batch to its end: answered, failed, or written off with its host.
     *
     * What an attempt means – for the breaker, for a pause, for the host’s
     * limit – is settled inside the slot, before the next queued batch can
     * start; every wait happens outside it, so a waiting host never holds a
     * slot another host could use. A further attempt queues again behind the
     * batches already waiting for its host. The breaker hears of each batch
     * once.
     */
    async function runBatch(
      batch: (typeof batches)[number],
    ): Promise<Array<readonly [string, FetchOutcome<Fact>]>> {
      let attempts = 0;
      let retries = 0;
      // Set once a stall has been counted and sent to the back of the queue.
      let stalled: FetchOutcome<Fact> | undefined;
      // Why the latest attempt failed, for a batch that is waiting to try again.
      let lastFailure: FetchOutcome<Fact> | undefined;
      // When the latest attempt started, in `tick`s.
      let startedAt = 0;
      // Whether the stall’s first failure was counted, so only then is it
      // taken back.
      let stallCounted = false;
      for (;;) {
        // Checked before queueing too, so a written-off host’s batches take no
        // slot.
        if (writtenOff.has(batch.host)) {
          return writtenOffStep().done;
        }
        const step = await limiter.run(batch.host, async (slot) => {
          // Queued before the host was written off: no request goes out, so the
          // slot says nothing about the host’s limit either way.
          if (writtenOff.has(batch.host)) {
            slot.ignore();
            return writtenOffStep();
          }
          attempts++;
          startedAt = ++tick;
          const result = await attempt(batch.entries);
          if (result.kind === 'threw') {
            slot.overloaded();
          }
          return settle(result);
        });
        if ('done' in step) {
          return step.done;
        }
        await delay(step.waitMs);
      }

      function writtenOffStep(): Done<Fact> {
        if (lastFailure !== undefined) {
          // Contacted already, and waiting to try again – after a stall or a
          // request to come back later: it keeps its charge and the reason it
          // actually failed for.
          return everyKey(lastFailure);
        }
        // The host has already failed its way out of this run. Answering
        // without a request is the whole point: retrying every reference
        // against a host that is down is the stampede, not the remedy. It sent
        // nothing, so it is refunded.
        skipped += batch.entries.length;
        return everyKey({
          kind: 'failed',
          writtenOff: true,
          reason: `host ${batch.host} was written off after ${hostFailureThreshold} failures in its last ${failureWindow} batches; not contacted again this run`,
        });
      }

      function settle(result: BatchResult<Fact>): Step<Fact> {
        if (result.kind === 'answered') {
          // A batch of nothing but individual failures says nothing about the
          // host: as a success it would hide a host that serves only broken
          // documents, as a failure it would write off one whose other
          // references are fine.
          if (stalled !== undefined) {
            // The host answered after all: the stall was a slow moment, not a
            // dead host, so the failure counted for it is taken back.
            if (stallCounted) {
              forgiveStall(batch.host);
            }
          } else if (!result.individualOnly) {
            noteHostOutcome(batch.host, true);
          }
          return { done: result.outcomes };
        }

        const { error } = result;
        if (error instanceof RetryableError) {
          // A wait longer than an attempt may take is not waited out: the
          // source will not answer within this run’s patience, so the next run
          // asks instead.
          const tooLong =
            error.retryAfterMs !== undefined && error.retryAfterMs > timeoutMs;
          if (retries < RETRIES && !tooLong) {
            const backoffMs = RETRY_DELAY_MS * 2 ** retries;
            retries++;
            lastFailure = failedOutcome(error, attempts, '');
            // `Retry-After: 0`, or a date skewed into the past, names no real
            // delay, so it gets our own backoff rather than an instant burst.
            if (error.retryAfterMs === undefined || error.retryAfterMs <= 0) {
              return { waitMs: backoffMs };
            }
            // A rate limit is about this client, so every batch for the host
            // waits, not just the one that was told.
            limiter.pause(batch.host, Date.now() + error.retryAfterMs);
            return { waitMs: 0 };
          }
          return failed(
            error,
            tooLong
              ? `; asked to retry after ${error.retryAfterMs}ms, longer than the ${timeoutMs}ms timeout`
              : '',
          );
        }
        if (stalled === undefined && isPassing(error)) {
          // A stall that may pass gets one more attempt at the back of the
          // queue, at no second unit of the budget, which counts references,
          // not requests. It counts against the host now, not after that
          // attempt, or a host that times out on everything would cost every
          // reference a full timeout before the breaker could see it.
          stallCounted = noteFailure();
          stalled = failedOutcome(error, attempts, '');
          lastFailure = stalled;
          return { waitMs: 0 };
        }
        return failed(error, '');
      }

      function failed(error: unknown, suffix: string): Step<Fact> {
        // A stall was counted when it first failed; its second attempt is not
        // counted again.
        if (stalled === undefined) {
          noteFailure();
        }
        return everyKey(failedOutcome<Fact>(error, attempts, suffix));
      }

      /**
       * Count a failure against the host, once per burst, and answer whether it
       * was counted. When a host goes down, everything in flight fails
       * together: that is one signal, so a failure of an attempt that started
       * before the host’s last counted failure is not counted again.
       */
      function noteFailure(): boolean {
        // The rest of the burst that wrote its host off has nothing left to
        // tell the breaker.
        if (
          writtenOff.has(batch.host) ||
          (lastCountedAt.get(batch.host) ?? 0) > startedAt
        ) {
          return false;
        }
        lastCountedAt.set(batch.host, ++tick);
        noteHostOutcome(batch.host, false);
        return true;
      }

      function everyKey(outcome: FetchOutcome<Fact>): Done<Fact> {
        return {
          done: batch.entries.map(({ key }) => [key, outcome] as const),
        };
      }
    }
  }

  /**
   * Take back the failure a stall was counted for, now that its second attempt
   * was answered: turn the host’s latest failure in the window into a success.
   * Nothing to take back once the host is written off, or when the failure has
   * already slid out of the window.
   */
  function forgiveStall(host: string): void {
    const window = recentFailures.get(host);
    if (window === undefined) {
      return;
    }
    window[window.lastIndexOf(true)] = false;
    // The burst the stall belonged to may still be in flight, so its marker in
    // `lastCountedAt` stays.
    if (!window.includes(true)) {
      recentFailures.delete(host);
    }
  }

  /**
   * Record a batch against its host, and write the host off once the threshold
   * of failures is reached among its last `2 × threshold` batches. A window
   * rather than a run of consecutive failures, so a host where most references
   * fail is cut off even when a few succeed in between.
   */
  function noteHostOutcome(host: string, succeeded: boolean): void {
    const window = recentFailures.get(host) ?? [];
    window.push(!succeeded);
    if (window.length > failureWindow) {
      window.shift();
    }
    const failures = window.filter(Boolean).length;
    if (failures >= hostFailureThreshold) {
      writtenOff.add(host);
      recentFailures.delete(host); // Nothing reads it once written off.
      lastCountedAt.delete(host);
    } else if (failures === 0) {
      // A window of successes counts the same as no window at all, so a
      // healthy host holds no memory.
      recentFailures.delete(host);
      lastCountedAt.delete(host);
    } else {
      recentFailures.set(host, window);
    }
  }

  /**
   * One call to `fetch` for a batch, bounded in time. A throw is caught and
   * handed back, so one failing call degrades its own references and nothing
   * else; what to make of it is {@link runBatch}’s to decide.
   */
  async function attempt(
    entries: readonly Keyed<Reference>[],
  ): Promise<BatchResult<Fact>> {
    try {
      const found = new Map(
        await fetchWithin(entries.map((entry) => entry.reference)),
      );
      let individualOnly = true;
      const outcomes = entries.map(
        ({ key }): readonly [string, FetchOutcome<Fact>] => {
          const fact = found.get(key);
          if (fact instanceof ReferenceFailure) {
            return [key, { kind: 'failed', reason: fact.reason }];
          }
          individualOnly = false;
          return fact === undefined
            ? [key, { kind: 'absent' }]
            : [key, { kind: 'present', fact }];
        },
      );
      return { kind: 'answered', outcomes, individualOnly };
    } catch (error) {
      return { kind: 'threw', error };
    }
  }

  /**
   * One attempt, abandoned as a failure when it outruns the timeout. The signal
   * is handed to `fetch` so a caller can cancel the request rather than being
   * left running behind an answer nobody waits for.
   */
  async function fetchWithin(
    references: readonly Reference[],
  ): Promise<Iterable<readonly [string, Fact | ReferenceFailure]>> {
    const controller = new AbortController();
    const expiry = setTimeout(() => controller.abort(), timeoutMs);
    try {
      return await Promise.race([
        options.fetch(references, { signal: controller.signal }),
        rejectWhenAborted(controller.signal, timeoutMs),
      ]);
    } catch (error) {
      // Our deadline passed, whichever rejection won the race: a `fetch` that
      // rejects on the abort with its own error must still read as a timeout.
      if (controller.signal.aborted) {
        throw new AttemptTimeout(`timed out after ${timeoutMs}ms`);
      }
      throw error;
    } finally {
      clearTimeout(expiry);
    }
  }
}

/** An attempt that outran {@link ResolverLimits.timeoutMs}. */
class AttemptTimeout extends Error {}

/**
 * Network error codes that may pass within the run: a dropped or refused
 * connection, a connect that timed out, a temporary DNS failure. `ENOTFOUND` is
 * left out – a name that does not resolve will not a few seconds later either.
 */
const PASSING_CODES = new Set([
  'ECONNRESET',
  'ECONNREFUSED',
  'ETIMEDOUT',
  'EAI_AGAIN',
  'UND_ERR_SOCKET',
  'UND_ERR_CONNECT_TIMEOUT',
]);

/**
 * Whether a failure may pass on its own within the run – a stall rather than an
 * answer – and so earns one more attempt at the back of the queue: our own
 * timeout, or a network error code on the error or on its `cause`, which is
 * where Node’s `fetch` puts it.
 */
function isPassing(error: unknown): boolean {
  return (
    error instanceof AttemptTimeout ||
    PASSING_CODES.has(codeOf(error)) ||
    (error instanceof Error && PASSING_CODES.has(codeOf(error.cause)))
  );
}

function codeOf(error: unknown): string {
  return typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    typeof error.code === 'string'
    ? error.code
    : '';
}

/** Reject as soon as the attempt’s deadline passes, whatever `fetch` is doing. */
function rejectWhenAborted(
  signal: AbortSignal,
  timeoutMs: number,
): Promise<never> {
  return new Promise<never>((_resolve, reject) => {
    signal.addEventListener(
      'abort',
      () => reject(new AttemptTimeout(`timed out after ${timeoutMs}ms`)),
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
  | {
      readonly kind: 'failed';
      readonly reason: string;
      /** Not sent: its host had already been written off. */
      readonly writtenOff?: true;
    };

/**
 * What to count a key as, from its fetch outcome – none when it was not
 * fetched – and whether it was due a fetch the budget did not allow.
 */
function countOf<Fact>(
  outcome: FetchOutcome<Fact> | undefined,
  deferred: boolean,
): ResolutionCount {
  if (outcome === undefined) {
    return deferred ? 'deferred' : 'from store';
  }
  if (outcome.kind === 'present') return 'fetched';
  if (outcome.kind === 'absent') return 'absent';
  return outcome.writtenOff ? 'written off' : 'failed';
}

/**
 * What one call to `fetch` came to: an answer per key, with whether every key
 * in it was a {@link ReferenceFailure}, or the throw that failed the call.
 */
type BatchResult<Fact> =
  | {
      readonly kind: 'answered';
      readonly outcomes: Array<readonly [string, FetchOutcome<Fact>]>;
      readonly individualOnly: boolean;
    }
  | { readonly kind: 'threw'; readonly error: unknown };

/**
 * Where a batch stands after one turn in its slot: done, with an outcome per
 * key, or to queue again after waiting this long outside the slot.
 */
type Step<Fact> = Done<Fact> | { readonly waitMs: number };

/** A batch’s answer, per key. */
interface Done<Fact> {
  readonly done: Array<readonly [string, FetchOutcome<Fact>]>;
}

/** A batch’s failure, as every key in it reports it. */
function failedOutcome<Fact>(
  error: unknown,
  attempts: number,
  suffix: string,
): FetchOutcome<Fact> {
  return {
    kind: 'failed',
    reason: `resolution failed after ${attempts} attempt(s): ${describe(error)}${suffix}`,
  };
}

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

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Wait this long; a moment already past resolves at once. */
function delay(milliseconds: number): Promise<void> {
  if (milliseconds <= 0) {
    return Promise.resolve();
  }
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}
