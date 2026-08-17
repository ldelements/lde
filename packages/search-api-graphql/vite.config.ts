/// <reference types='vitest' />
import { defineConfig, mergeConfig } from 'vite';
import baseConfig from '../../vite.base.config.js';

export default mergeConfig(
  baseConfig,
  defineConfig({
    root: __dirname,
    cacheDir: '../../node_modules/.vite/packages/search-api-graphql',
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
        exclude: ['src/cli.ts', 'test/fixtures/**'],
        thresholds: {
          functions: 100,
          lines: 100,
          // Full-suite baseline, re-anchored when covered branches are
          // deleted (autoUpdate only ever raises; see AGENTS.md).
          // Re-anchored for the selection-set projection: a lookup selected
          // without sub-fields parses but never validates, so that branch is
          // reachable only from a direct caller.
          // Re-anchored for the selection-set projection: its defensive reads
          // (an unresolvable target, an absent field list) are reachable only
          // from a direct caller, since GraphQL validates the query first.
          branches: 96.65,
          statements: 100,
        },
      },
    },
  }),
);
