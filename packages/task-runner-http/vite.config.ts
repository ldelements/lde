/// <reference types='vitest' />
import { defineConfig, mergeConfig } from 'vite';
import baseConfig from '../../vite.base.config.js';

export default mergeConfig(
  baseConfig,
  defineConfig({
    root: __dirname,
    cacheDir: '../../node_modules/.vite/packages/task-runner-native',
    test: {
      coverage: {
        thresholds: {
          functions: 100,
          lines: 97.8,
          branches: 87.75,
          statements: 97.84,
        },
      },
    },
  }),
);
