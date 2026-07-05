/// <reference types='vitest' />
import { defineConfig, mergeConfig } from 'vite';
import baseConfig from '../../vite.base.config.js';

export default mergeConfig(
  baseConfig,
  defineConfig({
    root: __dirname,
    cacheDir: '../../node_modules/.vite/packages/search-typesense',
    test: {
      // Pulling and starting the Typesense container is slow on a cold cache.
      testTimeout: 60_000,
      hookTimeout: 120_000,
      coverage: {
        // Streaming rebuild + per-alias lock. The lock’s unexpected-status
        // rethrow guards and best-effort cleanup paths are deliberately not
        // exercised, which is why branch coverage is lower.
        thresholds: {
          // Dipped a hair when covered plumbing moved to @lde/search
          // (filterOperator, the schema-membership guard) and the hand-rolled
          // searchable predicate was deleted: fewer covered lines in this
          // package, same substantive coverage.
          functions: 96.92,
          lines: 95.14,
          branches: 90.95,
          statements: 95.19,
        },
      },
    },
  }),
);
