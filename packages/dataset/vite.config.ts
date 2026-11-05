import { defineConfig, mergeConfig } from 'vitest/config';
import baseConfig from '../../vite.base.config.js';

export default mergeConfig(
  baseConfig,
  defineConfig({
    root: __dirname,
    cacheDir: '../../node_modules/.vite/packages/dataset',
    test: {
      coverage: {
        thresholds: {
          autoUpdate: true,
          functions: 100,
          lines: 100,
          branches: 100,
          statements: 100,
        },
      },
    },
  }),
);
