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
          // autoUpdate off: coverage of probe.ts is timing-dependent (small
          // arrow callbacks in content-type matching run only under certain
          // response orderings), so a lucky run must not ratchet the
          // thresholds above the deterministic floor – that made CI fail
          // nondeterministically on unrelated PRs (observed floor: functions
          // 98.36, statements 99.28 on unlucky runs).
          autoUpdate: false,
          lines: 99,
          functions: 98.3,
          branches: 96.5,
          statements: 99.2,
        },
      },
    },
  }),
);
