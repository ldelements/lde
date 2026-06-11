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
        thresholds: {
          autoUpdate: true,
          functions: 95.55,
          lines: 95.17,
          branches: 89.87,
          statements: 94.64,
        },
      },
    },
  }),
);
