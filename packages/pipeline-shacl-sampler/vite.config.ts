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
          functions: 96.77,
          lines: 97.26,
          branches: 89.87,
          statements: 94.96,
        },
      },
    },
  }),
);
