/// <reference types='vitest' />
import { defineConfig, mergeConfig } from 'vite';
import baseConfig from '../../vite.base.config.js';

export default mergeConfig(
  baseConfig,
  defineConfig({
    root: __dirname,
    cacheDir: '../../node_modules/.vite/packages/distribution-downloader',
    test: {
      coverage: {
        thresholds: {
          autoUpdate: true,
          lines: 91.17,
          functions: 100,
          branches: 100,
          statements: 91.17,
        },
      },
    },
  }),
);
