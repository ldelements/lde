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
          functions: 63.63,
          lines: 62.62,
          branches: 40.38,
          statements: 63,
        },
      },
    },
  }),
);
