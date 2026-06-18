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
          functions: 96.66,
          lines: 95.65,
          branches: 84.61,
          statements: 94.94,
        },
      },
    },
  }),
);
