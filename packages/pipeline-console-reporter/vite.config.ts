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
          functions: 72,
          lines: 66.66,
          branches: 44.64,
          statements: 66.97,
        },
      },
    },
  }),
);
