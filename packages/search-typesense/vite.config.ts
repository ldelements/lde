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
        // One streaming rebuild plus best-effort cleanup paths (delete-on-
        // failure, non-404 alias rethrow) that are deliberately not exercised.
        thresholds: {
          functions: 83.33,
          lines: 91.48,
          branches: 84.21,
          statements: 91.66,
        },
      },
    },
  }),
);
