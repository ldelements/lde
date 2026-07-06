/// <reference types='vitest' />
import { defineConfig, mergeConfig } from 'vite';
import baseConfig from '../../vite.base.config.js';

export default mergeConfig(
  baseConfig,
  defineConfig({
    root: __dirname,
    cacheDir: '../../node_modules/.vite/packages/search-api-graphql',
    test: {
      coverage: {
        thresholds: {
          functions: 100,
          lines: 100,
          // Full-suite baseline, re-anchored when covered branches are
          // deleted (autoUpdate only ever raises; see AGENTS.md).
          branches: 92.66,
          statements: 100,
        },
      },
    },
  }),
);
