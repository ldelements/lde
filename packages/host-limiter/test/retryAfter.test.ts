import { describe, expect, it } from 'vitest';
import { parseRetryAfter } from '../src/index.js';

describe('parseRetryAfter', () => {
  const now = new Date('2026-11-10T10:00:00.000Z');

  it('reads a number of seconds', () => {
    expect(parseRetryAfter('120', now)).toBe(120_000);
  });

  it('reads an HTTP date as the time left until it', () => {
    expect(parseRetryAfter('Tue, 10 Nov 2026 10:00:30 GMT', now)).toBe(30_000);
  });

  it('answers nothing for no wait at all, so the caller backs off itself', () => {
    expect(parseRetryAfter('0', now)).toBeUndefined();
    expect(
      parseRetryAfter('Tue, 10 Nov 2026 09:59:00 GMT', now),
    ).toBeUndefined();
  });

  it('answers nothing for a missing or unreadable header', () => {
    // `Headers.get` answers null for a header that is not there.
    expect(parseRetryAfter(null, now)).toBeUndefined();
    expect(parseRetryAfter('soon', now)).toBeUndefined();
    expect(parseRetryAfter('-5', now)).toBeUndefined();
  });
});
