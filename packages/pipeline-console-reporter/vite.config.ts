import { defineConfig, mergeConfig } from 'vitest/config';
import baseConfig from '../../vite.base.config.js';

export default mergeConfig(
  baseConfig,
  defineConfig({
    root: __dirname,
    cacheDir: '../../node_modules/.vite/packages/pipeline-console-reporter',
    test: {
      coverage: {
        thresholds: {
          autoUpdate: true,
          functions: 66.66,
          lines: 64.07,
          branches: 42.59,
          statements: 64.42,
        },
      },
    },
  }),
);
