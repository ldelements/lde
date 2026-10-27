import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';

describe('CLI Unit Tests', () => {
  let originalArgv: string[];
  let consoleLogSpy: ReturnType<typeof vi.spyOn>;
  let consoleErrorSpy: ReturnType<typeof vi.spyOn>;
  let processExitSpy: any;

  beforeEach(() => {
    originalArgv = process.argv;
    consoleLogSpy = vi
      .spyOn(console, 'log')
      .mockImplementation(() => undefined);
    consoleErrorSpy = vi
      .spyOn(console, 'error')
      .mockImplementation(() => undefined);
    processExitSpy = vi
      .spyOn(process, 'exit')
      .mockImplementation(() => undefined as never) as any;
    vi.resetModules();
  });

  afterEach(() => {
    process.argv = originalArgv;
    consoleLogSpy.mockRestore();
    consoleErrorSpy.mockRestore();
    processExitSpy.mockRestore();
  });

  it('should handle success case', async () => {
    vi.doMock('../src/index.js', () => ({
      generateDocumentation: vi.fn().mockResolvedValue('Mock documentation'),
    }));

    process.argv = [
      'node',
      'cli.js',
      'from-shacl',
      'test.ttl',
      'template.liquid',
    ];
    await import('../src/cli.js');

    expect(consoleLogSpy).toHaveBeenCalledWith('Mock documentation');
  });

  it('passes the frame and partials folder on', async () => {
    const generateDocumentation = vi.fn().mockResolvedValue('');
    vi.doMock('../src/index.js', () => ({ generateDocumentation }));

    process.argv = [
      'node',
      'cli.js',
      'from-shacl',
      'test.ttl',
      'template.liquid',
      '--frame',
      'frame.jsonld',
      '--partials',
      'partials',
    ];
    await import('../src/cli.js');

    expect(generateDocumentation).toHaveBeenCalledWith(
      'test.ttl',
      'template.liquid',
      'frame.jsonld',
      'partials',
    );
  });

  it('should handle Error instance', async () => {
    vi.doMock('../src/index.js', () => ({
      generateDocumentation: vi.fn().mockRejectedValue(new Error('Test error')),
    }));

    process.argv = [
      'node',
      'cli.js',
      'from-shacl',
      'test.ttl',
      'template.liquid',
    ];
    await import('../src/cli.js');

    expect(consoleErrorSpy).toHaveBeenCalledWith('Error: Test error');
    expect(processExitSpy).toHaveBeenCalledWith(1);
  });

  it('should handle non-Error value', async () => {
    vi.doMock('../src/index.js', () => ({
      generateDocumentation: vi.fn().mockRejectedValue('String error'),
    }));

    process.argv = [
      'node',
      'cli.js',
      'from-shacl',
      'test.ttl',
      'template.liquid',
    ];
    await import('../src/cli.js');

    expect(consoleErrorSpy).toHaveBeenCalledWith('Error: String error');
    expect(processExitSpy).toHaveBeenCalledWith(1);
  });
});
