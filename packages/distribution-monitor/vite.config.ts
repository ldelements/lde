import { defineConfig, mergeConfig } from 'vitest/config';
import baseConfig from '../../vite.base.config.js';

export default mergeConfig(
  baseConfig,
  defineConfig({
    root: __dirname,
    cacheDir: '../../node_modules/.vite/packages/distribution-monitor',
    test: {
      coverage: {
        exclude: ['src/cli.ts', 'drizzle.config.ts'],
        thresholds: {
          autoUpdate: true,
          functions: 96.29,
          lines: 94.18,
          branches: 78.26,
          statements: 92.7,
        },
      },
    },
  }),
);
