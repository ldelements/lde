import { defineConfig, mergeConfig } from 'vitest/config';
import baseConfig from '../../vite.base.config.js';

export default mergeConfig(
  baseConfig,
  defineConfig({
    root: __dirname,
    cacheDir: '../../node_modules/.vite/packages/pipeline-shacl-sampler',
    test: {
      coverage: {
        thresholds: {
          autoUpdate: true,
          functions: 100,
          lines: 98.78,
          branches: 90.24,
          statements: 96.68,
        },
      },
    },
  }),
);
