import { mkdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname } from 'node:path';
import type { DatabaseSync as Database } from 'node:sqlite';
import type { FactStore, StoredFact } from './store.js';

/** How long a write waits for another process’s lock before giving up. */
const BUSY_TIMEOUT_MS = 5_000;
/**
 * Keys per statement. SQLite bounds how many parameters one statement may
 * carry – 250 000 in Node’s build, but a build is not a contract – and a
 * caller may hand `resolveAll` more references than that.
 */
const KEYS_PER_STATEMENT = 500;
/** The key `check()` writes and rolls back to prove the store is writable. */
const PROBE_KEY = '__lde_resolver_write_probe__';

export interface SqliteFactStoreOptions {
  /**
   * Path of the SQLite database file. Parent directories are created on open.
   * Must sit on a durable volume to survive across runs – a Kubernetes CronJob’s
   * container filesystem is discarded, taking every resolved fact with it.
   *
   * `:memory:` opens a private in-process database, which is
   * {@link memoryFactStore} with extra steps; prefer that one for tests.
   */
  path: string;
  /**
   * Table to hold the rows, created if absent. Defaults to `facts`. Name a
   * different one to keep two key spaces apart in a single file – facts of
   * different size or volatility, resolved by different resolvers. Facts sized
   * in bytes and facts sized in megabytes want different `batchSize`s, so they
   * want different tables.
   */
  table?: string;
}

/**
 * A {@link FactStore} backed by SQLite through Node’s own `node:sqlite`, so
 * durable keyed storage costs no dependency.
 *
 * Keyed reads and single-row writes are the point – nothing here is ever
 * queried by anything but key. What SQLite buys over a file per key is scale:
 * a small derived fact costs a row rather than a 4 KB block and an inode, the
 * whole store is one file to copy or mount, a batch read is one query rather
 * than hundreds of round trips on a network volume, and an IRI is a primary key
 * rather than a filename that must be hashed to fit. What it costs is
 * single-writer semantics, which is why writes open with a busy timeout.
 *
 * A deployment that needs many concurrent writers, or that distrusts SQLite’s
 * locking on its network filesystem, can ship a file-per-key `FactStore`
 * instead: the seam is the deliverable, this is only the default.
 *
 * Facts are stored as JSON, so a `Fact` must survive a `JSON` round trip.
 * An absence stores no fact at all – a null column and a status, so a key the
 * source does not know is remembered as cheaply as one it does.
 */
export function sqliteFactStore<Fact>(
  options: SqliteFactStoreOptions,
): FactStore<Fact> {
  const table = options.table ?? 'facts';
  assertPlainIdentifier(table);
  let database: Database | undefined;

  // Opened lazily and kept open: a resolver reads once and writes once per
  // batch, and reopening per call would pay the page-cache cost every time.
  const open = (): Database => {
    if (database === undefined) {
      mkdirSync(dirname(options.path), { recursive: true });
      // Loaded here rather than imported at the top, so that importing
      // '@lde/resolver' does not require `node:sqlite` of a runtime that lacks
      // it: a consumer wanting only memoryFactStore should not fail on an
      // unknown builtin module at import time.
      const { DatabaseSync } = createRequire(import.meta.url)(
        'node:sqlite',
      ) as typeof import('node:sqlite');
      // The busy timeout is what makes a second writer wait for the lock
      // instead of failing on the spot.
      database = new DatabaseSync(options.path, { timeout: BUSY_TIMEOUT_MS });
      database.exec(
        `CREATE TABLE IF NOT EXISTS ${table} (
           key TEXT PRIMARY KEY,
           status TEXT NOT NULL,
           fact TEXT,
           fetched_at TEXT NOT NULL,
           version TEXT NOT NULL
         )`,
      );
    }
    return database;
  };

  return {
    async close() {
      // A store outlives the resolvers that read it, so releasing the handle is
      // the owner’s call: a process building one store per run would otherwise
      // hold every database it ever opened until it exited.
      database?.close();
      database = undefined;
    },

    async check() {
      let connection: Database;
      try {
        connection = open();
      } catch (error) {
        throw unwritable(options.path, error);
      }
      // Opening proves nothing once the store exists: a database left over from
      // an earlier run opens, and even takes a transaction, when its file or
      // directory is no longer writable. Only an actual write says so – rolled
      // back, so the probe leaves nothing behind.
      try {
        connection.exec('BEGIN');
        connection
          .prepare(
            `INSERT INTO ${table} (key, status, fact, fetched_at, version)
             VALUES (?, 'present', NULL, '', '')`,
          )
          .run(PROBE_KEY);
        connection.exec('ROLLBACK');
      } catch (error) {
        rollBack(connection);
        throw unwritable(options.path, error);
      }
    },

    async get(keys) {
      const found = new Map<string, StoredFact<Fact>>();
      if (keys.length === 0) {
        return found;
      }
      const connection = open();
      for (const window of windows(keys)) {
        const placeholders = window.map(() => '?').join(', ');
        const rows = connection
          .prepare(
            `SELECT key, status, fact, fetched_at, version FROM ${table} WHERE key IN (${placeholders})`,
          )
          .all(...window) as Array<{
          key: string;
          status: string;
          fact: string | null;
          fetched_at: string;
          version: string;
        }>;
        for (const row of rows) {
          found.set(
            row.key,
            row.status === 'absent' || row.fact === null
              ? {
                  status: 'absent',
                  fetchedAt: row.fetched_at,
                  version: row.version,
                }
              : {
                  status: 'present',
                  fact: JSON.parse(row.fact) as Fact,
                  fetchedAt: row.fetched_at,
                  version: row.version,
                },
          );
        }
      }
      return found;
    },

    async set(outcomes, fetchedAt, version) {
      if (outcomes.size === 0) {
        return;
      }
      const connection = open();
      const upsert = connection.prepare(
        `INSERT INTO ${table} (key, status, fact, fetched_at, version) VALUES (?, ?, ?, ?, ?)
           ON CONFLICT(key) DO UPDATE SET
             status = excluded.status,
             fact = excluded.fact,
             fetched_at = excluded.fetched_at,
             version = excluded.version`,
      );
      // One transaction per write, so a run killed mid-batch leaves the store
      // holding either all of that batch or none of it.
      connection.exec('BEGIN');
      try {
        for (const [key, outcome] of outcomes) {
          upsert.run(
            key,
            outcome.status,
            outcome.status === 'present' ? JSON.stringify(outcome.fact) : null,
            fetchedAt,
            version,
          );
        }
        connection.exec('COMMIT');
      } catch (error) {
        // Guarded: a write that failed on a locked database may have aborted
        // the transaction already, and a throwing rollback would replace the
        // error that actually explains the failure.
        rollBack(connection);
        throw error;
      }
    },

    async purge(keys) {
      if (keys.length === 0) {
        return;
      }
      const connection = open();
      for (const window of windows(keys)) {
        const placeholders = window.map(() => '?').join(', ');
        connection
          .prepare(`DELETE FROM ${table} WHERE key IN (${placeholders})`)
          .run(...window);
      }
    },
  };
}

/** The keys in windows small enough for one statement’s parameter list. */
function* windows(keys: readonly string[]): Generator<readonly string[]> {
  for (let start = 0; start < keys.length; start += KEYS_PER_STATEMENT) {
    yield keys.slice(start, start + KEYS_PER_STATEMENT);
  }
}

/** Roll back if a transaction is open, and never throw over the real error. */
function rollBack(connection: Database): void {
  try {
    connection.exec('ROLLBACK');
  } catch {
    // No transaction is active – it never opened, or the failure aborted it.
  }
}

function unwritable(path: string, cause: unknown): Error {
  return new Error(
    `Fact store ${path} is not writable; make it and its directory writable by the user this runs as: ${String(cause)}`,
    { cause },
  );
}

/**
 * Reject a table name that is anything but letters, digits and underscores.
 *
 * A table name cannot be a bound parameter, so it is interpolated – and an
 * interpolated identifier is exactly where SQL injection lives. Every key and
 * value below is bound; this is the one string that is not, so it is the one
 * string that is checked.
 */
function assertPlainIdentifier(table: string): void {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(table)) {
    throw new Error(
      `Fact store table name “${table}” must be letters, digits and underscores, starting with a letter or underscore.`,
    );
  }
}
