import { Distribution } from '@lde/dataset';
import { describe, it, expect, vi } from 'vitest';

const distribution = new Distribution(
  new URL('https://example.org/data.nt'),
  'application/n-triples',
);

/** A separately evaluated copy of this package, as an unhoisted install or
 *  version skew gives an importer and the code that inspects its results. */
async function copyOfPackage(): Promise<typeof import('../src/index.js')> {
  vi.resetModules();
  return import('../src/index.js');
}

describe('import results', () => {
  it('are recognised by another copy of the package', async () => {
    const importer = await copyOfPackage();
    const caller = await copyOfPackage();
    expect(caller.ImportSuccessful).not.toBe(importer.ImportSuccessful);

    expect(new importer.ImportSuccessful(distribution)).toBeInstanceOf(
      caller.ImportSuccessful,
    );
    expect(new importer.ImportFailed(distribution, 'error')).toBeInstanceOf(
      caller.ImportFailed,
    );
    expect(new importer.NotSupported()).toBeInstanceOf(caller.NotSupported);
  });

  it('are not mistaken for one another', async () => {
    const importer = await copyOfPackage();
    const caller = await copyOfPackage();
    const failed = new importer.ImportFailed(distribution, 'error');

    expect(failed).not.toBeInstanceOf(caller.ImportSuccessful);
    expect(failed).not.toBeInstanceOf(caller.NotSupported);
    expect(new importer.NotSupported()).not.toBeInstanceOf(caller.ImportFailed);
  });

  it('are not matched by unrelated values', async () => {
    const { ImportSuccessful } = await copyOfPackage();

    expect({ distribution }).not.toBeInstanceOf(ImportSuccessful);
    expect(null).not.toBeInstanceOf(ImportSuccessful);
    expect('ImportSuccessful').not.toBeInstanceOf(ImportSuccessful);
  });
});
