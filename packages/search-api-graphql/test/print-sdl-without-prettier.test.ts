import { fileURLToPath } from 'node:url';
import { describe, expect, it, vi } from 'vitest';
import { printSchemaModuleSdl } from '../src/print-sdl.js';

// Hoisted above the import above, so the optional peer is unloadable from the
// first import onwards. This case cannot share a file with the tests that
// format for real: a mock only reaches a module imported after it, and
// `vi.resetModules()` does not evict an optional peer Node has already
// resolved – which made the assertion depend on module-graph ordering.
vi.mock('prettier', () => {
  throw new Error('Cannot find package ‘prettier’');
});

describe('printSchemaModuleSdl without Prettier', () => {
  it('names the optional Prettier peer when it cannot be loaded', async () => {
    await expect(
      printSchemaModuleSdl({
        modulePath: fileURLToPath(
          new URL('./fixtures/no-options.mjs', import.meta.url),
        ),
      }),
    ).rejects.toThrowError(
      /Formatting the SDL requires “prettier”, an optional peer dependency .*, which could not be loaded: /,
    );
  });
});
