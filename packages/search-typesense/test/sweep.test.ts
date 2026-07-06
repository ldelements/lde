import { describe, expect, it } from 'vitest';
import {
  departedSources,
  sourceDocumentsFilter,
  staleDocumentsFilter,
} from '../src/sweep.js';

describe('departedSources', () => {
  it('returns sources that are indexed but no longer selected', () => {
    const departed = departedSources(
      ['http://example.org/a', 'http://example.org/b', 'http://example.org/c'],
      ['http://example.org/a', 'http://example.org/c'],
    );

    expect(departed).toEqual(['http://example.org/b']);
  });

  it('keeps selected-but-skipped sources: selection is membership, not processing', () => {
    // A dataset skipped as unchanged is still selected; its documents survive.
    const departed = departedSources(
      ['http://example.org/skipped'],
      ['http://example.org/skipped', 'http://example.org/new'],
    );

    expect(departed).toEqual([]);
  });

  it('returns nothing for an empty index', () => {
    expect(departedSources([], ['http://example.org/a'])).toEqual([]);
  });
});

describe('staleDocumentsFilter', () => {
  it('matches a source’s documents not touched by this run', () => {
    expect(staleDocumentsFilter('http://example.org/a', 'run-1')).toBe(
      'source:=`http://example.org/a` && last_seen:!=`run-1`',
    );
  });

  it('rejects values that would break out of the filter quoting', () => {
    expect(() => staleDocumentsFilter('http://example.org/`', 'run-1')).toThrow(
      /backtick/i,
    );
    expect(() => staleDocumentsFilter('http://example.org/a', '`')).toThrow(
      /backtick/i,
    );
  });
});

describe('sourceDocumentsFilter', () => {
  it('matches all of a source’s documents', () => {
    expect(sourceDocumentsFilter('http://example.org/a')).toBe(
      'source:=`http://example.org/a`',
    );
  });

  it('rejects values that would break out of the filter quoting', () => {
    expect(() => sourceDocumentsFilter('http://example.org/`')).toThrow(
      /backtick/i,
    );
  });
});
