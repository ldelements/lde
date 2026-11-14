import { describe, it, expect } from 'vitest';
import { classifyOutcome, isTransientError } from '../../src/sparql/failure.js';

const httpError = (status: number) =>
  new Error(
    `Invalid SPARQL endpoint response from http://example.org/sparql (HTTP status ${status}):\nbody`,
  );

describe('isTransientError', () => {
  it.each([408, 425, 429, 502, 503, 504])('is true for HTTP %i', (status) => {
    expect(isTransientError(httpError(status))).toBe(true);
  });

  it.each([400, 404, 500])('is false for HTTP %i', (status) => {
    expect(isTransientError(httpError(status))).toBe(false);
  });

  it('is false for an error without a status', () => {
    expect(isTransientError(new Error('Parse error'))).toBe(false);
  });

  it('is false for a value that is not an error', () => {
    expect(isTransientError('HTTP status 503')).toBe(false);
  });
});

describe('classifyOutcome', () => {
  it('is a timeout when the cause is an abort', () => {
    const cause = Object.assign(new Error('aborted'), { name: 'AbortError' });
    expect(classifyOutcome(new Error('fetch failed', { cause }))).toBe(
      'timeout',
    );
  });
});
