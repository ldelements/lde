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
          functions: 95.65,
          lines: 95.4,
          branches: 90.74,
          statements: 94.87,
        },
      },
    },
  }),
);
