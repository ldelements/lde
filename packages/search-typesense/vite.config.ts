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
        // Only the adapter remains; its error-handling branches are exercised
        // by integration, not unit, tests.
        thresholds: {
          functions: 100,
          lines: 93.1,
          branches: 75,
          statements: 93.33,
        },
      },
    },
  }),
);
