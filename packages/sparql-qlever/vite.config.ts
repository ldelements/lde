import { defineConfig, mergeConfig } from 'vitest/config';
import baseConfig from '../../vite.base.config.js';

export default mergeConfig(
  baseConfig,
  defineConfig({
    root: __dirname,
    cacheDir: '../../node_modules/.vite/packages/sparql-monitor',
    test: {
      env: {
        QLEVER_IMAGE: 'adfreiburg/qlever:commit-a14e0a0',
      },
      coverage: {
        thresholds: {
          autoUpdate: true,
          lines: 95.62,
          functions: 100,
          branches: 84.84,
          statements: 95.67,
        },
      },
    },
  }),
);
