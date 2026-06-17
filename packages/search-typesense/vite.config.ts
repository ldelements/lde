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
        // Lower than before frame-by-type moved to @lde/search.
        thresholds: {
          functions: 95.83,
          lines: 91.54,
          branches: 76.92,
          statements: 91.89,
        },
      },
    },
  }),
);
