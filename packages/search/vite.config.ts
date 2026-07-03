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
          lines: 98.22,
          branches: 92.25,
          statements: 98.29,
        },
      },
    },
  }),
);
