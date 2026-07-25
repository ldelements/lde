/// <reference types='vitest' />
import { defineConfig, mergeConfig } from 'vite';
import baseConfig from '../../vite.base.config.js';

export default mergeConfig(
  baseConfig,
  defineConfig({
    root: __dirname,
    cacheDir: '../../node_modules/.vite/packages/task-runner-docker',
    test: {
      coverage: {
        thresholds: {
          functions: 0,
          lines: 0,
          branches: 0,
          statements: 0,
        },
      },
    },
  }),
);
