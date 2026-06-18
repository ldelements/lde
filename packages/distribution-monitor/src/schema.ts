import {
  boolean,
  index,
  integer,
  pgTable,
  text,
  timestamp,
  uuid,
} from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';

const columns = {
  id: uuid('id').notNull(),
  monitor: text('monitor').notNull(),
  observedAt: timestamp('observed_at', { mode: 'date' }).notNull(),
  success: boolean('success').notNull(),
  responseTimeMs: integer('response_time_ms').notNull(),
  errorMessage: text('error_message'),
};

/**
 * Observations table — maps to SOSA Observation concept.
 */
export const observations = pgTable(
  'observations',
  {
    ...columns,
    id: columns.id.primaryKey().defaultRandom(),
    observedAt: columns.observedAt.defaultNow(),
  },
  (table) => [
    index('observations_monitor_idx').on(table.monitor),
    index('observations_observed_at_idx').on(table.observedAt),
    index('observations_monitor_observed_at_idx').on(
      table.monitor,
      sql`${table.observedAt} DESC`,
    ),
  ],
);

/**
 * Latest observation per monitor, keyed by `monitor`. Kept current by an upsert
 * on every write (see `PostgresObservationStore.store`) rather than a
 * materialized view: reads are always current, and there is no periodic
 * full-table `REFRESH` to fall behind, contend on locks, or scan the whole
 * `observations` history every cycle.
 */
export const latestObservations = pgTable('latest_observations', {
  // Fresh column builders (not the shared `columns`): drizzle binds a builder
  // instance to one table, so reusing `columns` across two tables would drop
  // this primary key — which `store`'s upsert relies on for ON CONFLICT.
  id: uuid('id').notNull(),
  monitor: text('monitor').primaryKey(),
  observedAt: timestamp('observed_at', { mode: 'date' }).notNull(),
  success: boolean('success').notNull(),
  responseTimeMs: integer('response_time_ms').notNull(),
  errorMessage: text('error_message'),
});
