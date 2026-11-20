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
          functions: 99.4,
          lines: 99.32,
          branches: 96.78,
          statements: 99.15,
        },
      },
    },
  }),
);
