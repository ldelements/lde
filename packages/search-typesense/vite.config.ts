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
          functions: 95,
          lines: 91,
          branches: 74,
          statements: 91,
        },
      },
    },
  }),
);
