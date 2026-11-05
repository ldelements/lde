import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import {
  PostgreSqlContainer,
  StartedPostgreSqlContainer,
} from '@testcontainers/postgresql';
import { sql } from 'drizzle-orm';
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import { PostgresObservationStore } from '../src/store.js';

describe('PostgresObservationStore', () => {
  it('exports create factory method', () => {
    expect(PostgresObservationStore.create).toBeInstanceOf(Function);
  });

  describe('integration', () => {
    let container: StartedPostgreSqlContainer;
    let store: PostgresObservationStore;

    beforeAll(async () => {
      container = await new PostgreSqlContainer('postgres:18').start();
      store = await PostgresObservationStore.create(
        container.getConnectionUri(),
      );
    }, 60000);

    afterAll(async () => {
      await store?.close();
      await container?.stop();
    }, 30000);

    it('initializes schema on first run', () => {
      expect(store).toBeDefined();
    });

    it('applies lock and statement timeouts to its connection', async () => {
      // Read the GUCs back off the store's own pooled connection.
      const db = (store as unknown as { db: PostgresJsDatabase }).db;
      const [lock] = await db.execute(sql`SHOW lock_timeout`);
      const [statement] = await db.execute(sql`SHOW statement_timeout`);
      expect(lock.lock_timeout).toBe('30s');
      expect(statement.statement_timeout).toBe('1min');
    });

    it('stores and retrieves observations', async () => {
      const observation = await store.store({
        monitor: 'test-monitor',
        observedAt: new Date(),
        success: true,
        responseTimeMs: 100,
        errorMessage: null,
      });

      expect(observation.id).toBeDefined();

      const retrieved = await store.get(observation.id);
      expect(retrieved?.id).toBe(observation.id);
      expect(retrieved?.monitor).toBe('test-monitor');
      expect(retrieved?.success).toBe(true);
      expect(retrieved?.responseTimeMs).toBe(100);
    });

    it('retrieves latest observations per monitor', async () => {
      // Store observations for two monitors
      await store.store({
        monitor: 'monitor-a',
        observedAt: new Date('2024-01-01'),
        success: true,
        responseTimeMs: 50,
        errorMessage: null,
      });
      await store.store({
        monitor: 'monitor-a',
        observedAt: new Date('2024-01-02'),
        success: false,
        responseTimeMs: 100,
        errorMessage: 'timeout',
      });
      await store.store({
        monitor: 'monitor-b',
        observedAt: new Date('2024-01-01'),
        success: true,
        responseTimeMs: 75,
        errorMessage: null,
      });

      const latest = await store.getLatest();

      expect(latest.size).toBeGreaterThanOrEqual(2);
      expect(latest.get('monitor-a')?.success).toBe(false);
      expect(latest.get('monitor-b')?.success).toBe(true);
    });

    it('does not let an out-of-order write move latest backwards', async () => {
      await store.store({
        monitor: 'monitor-ooo',
        observedAt: new Date('2024-03-02'),
        success: true,
        responseTimeMs: 10,
        errorMessage: null,
      });
      // An older observation arriving late must not overwrite the newer latest.
      await store.store({
        monitor: 'monitor-ooo',
        observedAt: new Date('2024-03-01'),
        success: false,
        responseTimeMs: 20,
        errorMessage: 'stale',
      });

      const latest = await store.getLatest();
      expect(latest.get('monitor-ooo')?.observedAt).toEqual(
        new Date('2024-03-02'),
      );
      expect(latest.get('monitor-ooo')?.success).toBe(true);
    });

    it('reconciles an existing database idempotently, without data loss', async () => {
      // Re-create the store against the already-provisioned database. The
      // declarative push must diff to an empty change set, so previously stored
      // observations survive (a destructive re-create would drop them).
      await store.close();
      store = await PostgresObservationStore.create(
        container.getConnectionUri(),
      );
      expect(store).toBeDefined();

      const latest = await store.getLatest();
      expect(latest.get('monitor-a')?.success).toBe(false);
      expect(latest.get('monitor-b')?.success).toBe(true);
    });
  });
});
