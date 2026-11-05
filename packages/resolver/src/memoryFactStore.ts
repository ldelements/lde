import type { FactStore, StoredFact } from './store.js';

/**
 * A {@link FactStore} that keeps rows in a `Map` for the lifetime of the
 * process.
 *
 * For tests, and for a run that deliberately wants no memory across runs. It is
 * **not** a cache with a bound: it holds every key it is given, so a production
 * deployment resolving a register-wide key space wants
 * {@link sqliteFactStore} instead.
 */
export function memoryFactStore<Fact>(
  initial?: ReadonlyMap<string, StoredFact<Fact>>,
): FactStore<Fact> {
  const rows = new Map<string, StoredFact<Fact>>(initial);
  return {
    async get(keys) {
      const found = new Map<string, StoredFact<Fact>>();
      for (const key of keys) {
        const stored = rows.get(key);
        if (stored !== undefined) {
          found.set(key, stored);
        }
      }
      return found;
    },
    async set(outcomes, fetchedAt, version) {
      for (const [key, outcome] of outcomes) {
        rows.set(key, { ...outcome, fetchedAt, version });
      }
    },
    async purge(keys) {
      for (const key of keys) {
        rows.delete(key);
      }
    },
  };
}
