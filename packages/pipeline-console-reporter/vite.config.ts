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
          functions: 96.29,
          lines: 87.05,
          branches: 72.5,
          statements: 87.14,
        },
      },
    },
  }),
);
