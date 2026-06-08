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
          lines: 97.43,
          functions: 100,
          branches: 89.47,
          statements: 95.45,
        },
      },
    },
  }),
);
