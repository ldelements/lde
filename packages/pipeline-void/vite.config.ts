/// <reference types='vitest' />
import { defineConfig, mergeConfig } from 'vite';
import baseConfig from '../../vite.base.config.js';

export default mergeConfig(
  baseConfig,
  defineConfig({
    root: __dirname,
    cacheDir: '../../node_modules/.vite/packages/pipeline-void',
    test: {
      coverage: {
        thresholds: {
          functions: 50,
          lines: 78.43,
          branches: 67.44,
          statements: 78.84,
        },
      },
    },
  }),
);
