/**
 * What the store remembers about a key: a fact, or that the source has none.
 *
 * An absence is a real answer and is remembered like any other. Without it a
 * key the source does not know is missing from the store every run, sorts ahead
 * of merely stale keys, and spends the run’s budget re-asking a question that
 * has already been answered – so a register with a tail of unknown keys never
 * warms.
 *
 * A failure is **not** here. It is transient, so it is never persisted: the
 * whole batch is simply retried next run, and a host that is down is handled
 * within the run by the resolver’s per-host breaker rather than by a record
 * that would hide the host’s recovery until a window expired.
 */
export type FactOutcome<Fact> =
  | { readonly status: 'present'; readonly fact: Fact }
  | { readonly status: 'absent' };

/**
 * A row as the store holds it: the outcome, when it was learnt, and the
 * version of the derivation that produced it.
 *
 * `fetchedAt` is an ISO 8601 instant rather than a number, because it is
 * routinely surfaced – a deployment that writes a resolved value into a search
 * document publishes the same stamp beside it, so a consumer can see how old an
 * authority-sourced value is.
 */
export type StoredFact<Fact> = FactOutcome<Fact> & {
  readonly fetchedAt: string;
  /**
   * The {@link ResolverOptions.version} in force when the row was written.
   * A row stamped with another version reads as missing: the fact is not old,
   * it is the wrong shape.
   */
  readonly version: string;
};

/**
 * Durable memory of facts resolved from outside the graph, keyed by the
 * caller’s key.
 *
 * The store is the **only** place a resolved fact lives between runs: the data
 * a pipeline reads is re-read from its publisher each run, and a search index is
 * rebuilt from its sources, so a fact fetched from a third party has nowhere
 * else to survive. A cold store therefore costs outbound requests, which is why
 * {@link ResolverLimits.fetchesPerResolver} exists and why the default backend
 * keeps a keyed file rather than a whole-file blob.
 *
 * A seam, deliberately: the interface is the deliverable and the backends are
 * replaceable – {@link sqliteFactStore} for a durable volume,
 * {@link memoryFactStore} for tests, anything else a deployment already
 * operates.
 *
 * Keys are opaque strings. **Facts must be small derived values**, not the
 * documents they were derived from: {@link FactStore.get} loads every requested
 * key into memory at once, so a batch of keys is only a memory bound when a
 * fact is bounded too. Store the dimensions, not the manifest they came from –
 * keeping the document is caching an HTTP response, which is a different job
 * with different rules. Values must survive `JSON` round-tripping in the
 * backends that serialize, which the shipped SQLite one does.
 */
export interface FactStore<Fact> {
  /**
   * Verify the store can persist facts, throwing when it cannot. A resolver
   * calls this from its own `check()`, so a deployment can fail a run at
   * startup – an unwritable mounted volume – rather than at the end of the
   * first batch, with the run’s fetch budget already spent on facts that
   * cannot be kept.
   *
   * Opening the store is not enough of a test: a store that exists from an
   * earlier run opens cleanly when it is no longer writable. Prove the write.
   */
  check?(): Promise<void>;
  /**
   * Release whatever the store holds open, if anything.
   *
   * A store is **process-scoped where a resolver is run-scoped**: it is the
   * thing that survives runs, so one store is built once and handed to as many
   * resolvers as the process makes. A long-lived process that instead builds a
   * store per run would accumulate one open handle per run, which is what this
   * exists to release. The store is unusable afterwards; build another.
   */
  close?(): Promise<void>;
  /**
   * The stored rows for these keys. Keys with nothing stored are simply absent
   * from the result; the map never holds a placeholder.
   */
  get(keys: readonly string[]): Promise<Map<string, StoredFact<Fact>>>;
  /**
   * Persist these outcomes under `fetchedAt` and `version`, replacing any
   * previous row for the same key.
   */
  set(
    outcomes: ReadonlyMap<string, FactOutcome<Fact>>,
    fetchedAt: string,
    version: string,
  ): Promise<void>;
  /**
   * Forget these keys. The store holds no validator, so a fact that turned out
   * wrong is durable until something removes it – purge is that something, and
   * the reason the TTL never has to evict.
   */
  purge(keys: readonly string[]): Promise<void>;
}
