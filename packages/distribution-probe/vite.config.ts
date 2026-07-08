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
          lines: 99.27,
          functions: 100,
          branches: 96.21,
          statements: 98.94,
        },
      },
    },
  }),
);
