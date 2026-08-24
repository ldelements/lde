/// <reference types='vitest' />
import { defineConfig, mergeConfig } from 'vite';
import baseConfig from '../../vite.base.config.js';

export default mergeConfig(
  baseConfig,
  defineConfig({
    root: __dirname,
    cacheDir: '../../node_modules/.vite/packages/distribution-probe',
    test: {
      coverage: {
        thresholds: {
          autoUpdate: true,
          lines: 100,
          functions: 100,
          // Re-anchored when the host-limited map moved to @lde/host-limiter:
          // fully covered code leaving the file lowers the ratio without
          // uncovering a line of what stayed.
          branches: 96.38,
          statements: 99.6,
        },
      },
    },
  }),
);
