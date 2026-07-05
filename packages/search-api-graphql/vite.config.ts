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
          // Branches dipped when the monolingual-text output branch was
          // deleted in favour of the single und-locale text model.
          branches: 92.38,
          statements: 100,
        },
      },
    },
  }),
);
