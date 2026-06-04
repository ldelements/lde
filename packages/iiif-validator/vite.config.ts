/// <reference types='vitest' />
import { defineConfig, mergeConfig } from 'vite';
import baseConfig from '../../vite.base.config.js';

export default mergeConfig(
  baseConfig,
  defineConfig({
    root: __dirname,
    cacheDir: '../../node_modules/.vite/packages/iiif-validator',
    test: {
      coverage: {
        thresholds: {
          autoUpdate: true,
          lines: 96.96,
          functions: 100,
          branches: 87.09,
          statements: 94.59,
        },
      },
    },
  }),
);
