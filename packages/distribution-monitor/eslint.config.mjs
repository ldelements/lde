import baseConfig from '../../eslint.config.mjs';

export default [
  ...baseConfig,
  {
    files: ['**/*.json'],
    rules: {
      '@nx/dependency-checks': [
        'error',
        {
          ignoredFiles: [
            '{projectRoot}/eslint.config.{js,cjs,mjs}',
            '{projectRoot}/vite.config.{js,ts,mjs,mts}',
            '{projectRoot}/drizzle.config.{js,ts,mjs,mts}',
          ],
          // postgres is used via drizzle-orm's postgres driver
          // c12, commander are used by CLI which is separate from main exports
          ignoredDependencies: ['postgres', 'c12', 'commander'],
        },
      ],
    },
    languageOptions: {
      parser: await import('jsonc-eslint-parser'),
    },
  },
];
