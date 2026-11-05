import { drizzle } from 'drizzle-orm/postgres-js';
import { eq, sql } from 'drizzle-orm';
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import * as schema from './schema.js';
import type { ObservationStore, Observation } from './types.js';

const { observations, latestObservations } = schema;

/**
 * Per-session Postgres timeouts applied to every pooled connection, so a
 * statement that blocks on a lock or runs away fails fast rather than hanging
 * indefinitely (which once stalled startup for hours). `lock_timeout` bounds
 * lock waits; `statement_timeout` is a generous backstop against a single
 * runaway query.
 */
const LOCK_TIMEOUT_MS = 30_000;
const STATEMENT_TIMEOUT_MS = 60_000;

/**
 * PostgreSQL implementation of the ObservationStore interface.
 */
export class PostgresObservationStore implements ObservationStore {
  private db: PostgresJsDatabase;

  private constructor(connectionString: string) {
    this.db = drizzle({
      connection: {
        url: connectionString,
        connection: {
          lock_timeout: LOCK_TIMEOUT_MS,
          statement_timeout: STATEMENT_TIMEOUT_MS,
        },
      },
    });
  }

  /**
   * Create a new store and reconcile the database schema with {@link schema}.
   *
   * Uses drizzle-kit's `pushSchema` to diff the declared schema against the live
   * database and apply only the difference, so an already-provisioned database
   * issues no DDL — no needless, lock-taking index re-creation on every start.
   *
   * drizzle-kit's push adapter expects `execute()` to return `{ rows }`, but
   * drizzle-orm's postgres-js driver resolves to a bare array, so the database
   * is wrapped to re-shape the result. See
   * https://github.com/drizzle-team/drizzle-orm/issues/5293.
   */
  static async create(
    connectionString: string,
  ): Promise<PostgresObservationStore> {
    const store = new PostgresObservationStore(connectionString);

    // Migrate away from the former `latest_observations` MATERIALIZED VIEW: it
    // was a derived cache (every value also lives in `observations`), so dropping
    // it loses nothing. Done before pushSchema so the declarative push can create
    // the replacement table without tripping the destructive-change guard below.
    // Guarded on pg_matviews, so it is a no-op once the table has taken over.
    await store.db.execute(sql`
      DO $$
      BEGIN
        IF EXISTS (
          SELECT 1 FROM pg_matviews WHERE matviewname = 'latest_observations'
        ) THEN
          DROP MATERIALIZED VIEW latest_observations;
        END IF;
      END $$;
    `);

    const { pushSchema } = await import('drizzle-kit/api-postgres');

    // #5293 shim: drizzle-kit reads `.rows` off the execute() result, which the
    // postgres-js driver returns as a bare array. Wrap it back into `{ rows }`.
    const pushAdapter = {
      execute: async (query: Parameters<PostgresJsDatabase['execute']>[0]) => ({
        rows: await store.db.execute(query),
      }),
    } as unknown as PostgresJsDatabase;

    const { sqlStatements } = await pushSchema(schema, pushAdapter);

    // `pushSchema` is state-based, so a removed or retyped column diffs to a
    // destructive statement. Refuse to drop data-bearing objects automatically —
    // that needs a deliberate migration, not an app-start side effect. Dropping
    // an index is a safe rebuild and stays allowed.
    const destructive = sqlStatements.find((statement) =>
      /\bDROP\s+(TABLE|MATERIALIZED\s+VIEW)\b|\bDROP\s+COLUMN\b/i.test(
        statement,
      ),
    );
    if (destructive) {
      throw new Error(
        `Refusing to apply a data-loss schema change automatically: ${destructive}`,
      );
    }

    for (const statement of sqlStatements) {
      await store.db.execute(sql.raw(statement));
    }

    return store;
  }

  async close(): Promise<void> {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await (this.db as any).$client.end();
  }

  async getLatest(): Promise<Map<string, Observation>> {
    const rows = await this.db.select().from(latestObservations);
    return new Map(rows.map((row) => [row.monitor, row]));
  }

  async get(id: string): Promise<Observation | null> {
    const rows = await this.db
      .select()
      .from(observations)
      .where(eq(observations.id, id))
      .limit(1);
    return rows[0] ?? null;
  }

  async store(observation: Omit<Observation, 'id'>): Promise<Observation> {
    return this.db.transaction(async (tx) => {
      const [inserted] = await tx
        .insert(observations)
        .values(observation)
        .returning();

      // Keep the latest-per-monitor row current in the same transaction. The
      // `setWhere` guard skips the update when a newer observation is already
      // recorded, so an out-of-order write can never move `latest` backwards.
      await tx
        .insert(latestObservations)
        .values(inserted)
        .onConflictDoUpdate({
          target: latestObservations.monitor,
          set: {
            id: inserted.id,
            observedAt: inserted.observedAt,
            success: inserted.success,
            responseTimeMs: inserted.responseTimeMs,
            errorMessage: inserted.errorMessage,
          },
          setWhere: sql`${latestObservations.observedAt} <= excluded.observed_at`,
        });

      return inserted;
    });
  }
}
