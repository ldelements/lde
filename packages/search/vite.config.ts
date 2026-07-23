/// <reference types='vitest' />
import { defineConfig, mergeConfig } from 'vite';
import baseConfig from '../../vite.base.config.js';

export default mergeConfig(
  baseConfig,
  defineConfig({
    root: __dirname,
    cacheDir: '../../node_modules/.vite/packages/search',
    test: {
      coverage: {
        thresholds: {
          functions: 100,
          lines: 100,
          branches: 98.89,
          statements: 100,
        },
      },
    },
  }),
);
