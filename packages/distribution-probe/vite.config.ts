/// <reference types='vitest' />
import { defineConfig, mergeConfig } from 'vite';
import baseConfig from '../../vite.base.config.js';

export default mergeConfig(
  baseConfig,
  defineConfig({
    root: __dirname,
    cacheDir: '../../node_modules/.vite/packages/distribution-probe',
    test: {
      coverage: {
        thresholds: {
          autoUpdate: true,
          lines: 99.32,
          functions: 100,
          branches: 91.5,
          statements: 98.68,
        },
      },
    },
  }),
);
