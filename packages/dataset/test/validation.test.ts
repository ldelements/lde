import { describe, expect, it } from 'vitest';
import { assertSafeIri } from '../src/validation.js';

describe('assertSafeIri', () => {
  it('accepts a valid IRI', () => {
    expect(() =>
      assertSafeIri('https://example.org/resource/123'),
    ).not.toThrow();
  });

  it('rejects an IRI containing ">"', () => {
    expect(() => assertSafeIri('http://example.org/x>')).toThrow(
      /unsafe characters/,
    );
  });

  it('rejects an IRI containing "<"', () => {
    expect(() => assertSafeIri('<http://evil.example>')).toThrow(
      /unsafe characters/,
    );
  });

  it('rejects an IRI containing a space', () => {
    expect(() => assertSafeIri('http://example.org/has space')).toThrow(
      /unsafe characters/,
    );
  });

  it('rejects an IRI containing a newline', () => {
    expect(() => assertSafeIri('http://example.org/\n')).toThrow(
      /unsafe characters/,
    );
  });

  it('rejects an IRI containing a control character', () => {
    expect(() => assertSafeIri('http://example.org/\x00')).toThrow(
      /unsafe characters/,
    );
  });
});
