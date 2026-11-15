import { defineConfig, mergeConfig } from 'vitest/config';
import baseConfig from '../../vite.base.config.js';

export default mergeConfig(
  baseConfig,
  defineConfig({
    root: __dirname,
    cacheDir: '../../node_modules/.vite/packages/pipeline',
    test: {
      fileParallelism: false,
      coverage: {
        // Test helpers shared between test files are not under test.
        exclude: ['test/**'],
        thresholds: {
          autoUpdate: true,
          functions: 99.41,
          lines: 98.78,
          branches: 96.82,
          statements: 98.63,
        },
      },
    },
  }),
);
