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
          // Honest full-suite baseline (autoUpdate raises it from here); a
          // partial vitest run must never rewrite these – see AGENTS.md. The
          // function figure moved when the projection lookup dropped its own
          // by-name map for the shared `rootTypeNamed`: one COVERED arrow fewer
          // over one function fewer, which lowers the ratio without uncovering
          // anything.
          functions: 99.15,
          lines: 99.47,
          // Re-anchored for the projection lookup: its guards against a
          // projection naming what no lookup reaches are unreachable through
          // the port, since `assertValidQuery` rejects such a query first.
          // They hold for a direct caller, and are exercised as one.
          branches: 95.7,
          statements: 99.48,
        },
      },
    },
  }),
);
