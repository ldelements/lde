import { defineConfig, mergeConfig } from 'vitest/config';
import baseConfig from '../../vite.base.config.js';

export default mergeConfig(
  baseConfig,
  defineConfig({
    root: __dirname,
    cacheDir: '../../node_modules/.vite/packages/fastify-rdf',
    test: {
      coverage: {
        thresholds: {
          autoUpdate: true,
          functions: 94.73,
          lines: 98.92,
          branches: 95.65,
          statements: 97.93,
        },
      },
    },
  }),
);
