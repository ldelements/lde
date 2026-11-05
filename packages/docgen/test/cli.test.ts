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

  it('passes each --context to generateDocumentation', async () => {
    const generateDocumentation = vi.fn().mockResolvedValue('');
    vi.doMock('../src/index.js', () => ({ generateDocumentation }));

    process.argv = [
      'node',
      'cli.js',
      'from-shacl',
      'test.ttl',
      'template.liquid',
      '--context',
      'https://schema.org=context.jsonld',
      '-c',
      'https://example.org/a=b=c.jsonld',
    ];
    await import('../src/cli.js');

    expect(generateDocumentation).toHaveBeenCalledWith(
      'test.ttl',
      'template.liquid',
      undefined,
      {
        contexts: {
          'https://schema.org': 'context.jsonld',
          'https://example.org/a=b': 'c.jsonld',
        },
      },
    );
  });

  it.each(['context.jsonld', '=context.jsonld', 'https://schema.org='])(
    'rejects --context %s',
    async (mapping) => {
      const generateDocumentation = vi.fn();
      vi.doMock('../src/index.js', () => ({ generateDocumentation }));
      const stderr = vi
        .spyOn(process.stderr, 'write')
        .mockImplementation(() => true);
      processExitSpy.mockImplementation(() => {
        throw new Error('exit');
      });

      process.argv = [
        'node',
        'cli.js',
        'from-shacl',
        'test.ttl',
        'template.liquid',
        '--context',
        mapping,
      ];
      await expect(import('../src/cli.js')).rejects.toThrow('exit');

      expect(stderr).toHaveBeenCalledWith(
        expect.stringContaining('Expected <url>=<file>.'),
      );
      expect(generateDocumentation).not.toHaveBeenCalled();
      stderr.mockRestore();
    },
  );
});
