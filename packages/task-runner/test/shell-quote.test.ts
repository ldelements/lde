import { shellQuote } from '../src/index.js';
import { describe, it, expect } from 'vitest';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const run = promisify(execFile);

/** Echoes `value` through `sh -c`, the way the task runners run a command. */
async function throughShell(value: string): Promise<string> {
  const { stdout } = await run('sh', ['-c', `printf %s ${shellQuote(value)}`]);
  return stdout;
}

describe('shellQuote', () => {
  it('wraps a plain value in single quotes', () => {
    expect(shellQuote('/data/chunk.csv')).toBe("'/data/chunk.csv'");
  });

  it('escapes an embedded single quote', () => {
    expect(shellQuote("/data/'s-Hertogenbosch.nt")).toBe(
      "'/data/'\\''s-Hertogenbosch.nt'",
    );
  });

  it.each([
    '/data/plain.csv',
    '/data/with space.csv',
    "/data/'s-Hertogenbosch.nt",
    '/data/semi;colon.csv',
    '/data/$(echo substituted).csv',
    '/data/`echo substituted`.csv',
    '/data/new\nline.csv',
  ])('survives a round trip through the shell: %j', async (value) => {
    expect(await throughShell(value)).toBe(value);
  });
});
