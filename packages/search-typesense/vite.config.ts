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
          functions: 96.87,
          lines: 93.49,
          branches: 84.05,
          statements: 93.55,
        },
      },
    },
  }),
);
