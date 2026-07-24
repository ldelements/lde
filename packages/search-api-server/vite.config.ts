import { defineConfig, mergeConfig } from 'vitest/config';
import baseConfig from '../../vite.base.config.js';

export default mergeConfig(
  baseConfig,
  defineConfig({
    root: __dirname,
    cacheDir: '../../node_modules/.vite/packages/search-api-server',
    resolve: {
      // graphql ships both CJS and ESM builds without an `exports` map. Vite
      // transforms our sources against the ESM build while the externalized
      // graphql-yoga loads the CJS build in Node, and graphql rejects schemas
      // crossing the two realms. Pin every import to the CJS build that Node
      // resolves, so tests exercise one graphql instance.
      alias: { graphql: 'graphql/index.js' },
    },
    test: {
      coverage: {
        exclude: ['src/cli.ts'],
        thresholds: {
          autoUpdate: true,
          functions: 100,
          lines: 100,
          branches: 97.56,
          statements: 100,
        },
      },
    },
  }),
);
