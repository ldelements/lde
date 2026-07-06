import { describe, expect, it } from 'vitest';
import {
  departedSources,
  membershipSweepFilters,
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

  it('escapes values that would break out of the filter quoting', () => {
    expect(staleDocumentsFilter('http://example.org/`', 'run-1')).toBe(
      'source:=`http://example.org/\\`` && last_seen:!=`run-1`',
    );
  });
});

describe('sourceDocumentsFilter', () => {
  it('matches all of a source’s documents', () => {
    expect(sourceDocumentsFilter('http://example.org/a')).toBe(
      'source:=`http://example.org/a`',
    );
  });
});

describe('membershipSweepFilters', () => {
  it('combines departed sources into one membership filter', () => {
    expect(
      membershipSweepFilters(['http://example.org/a', 'http://example.org/b']),
    ).toEqual(['source:=[`http://example.org/a`,`http://example.org/b`]']);
  });

  it('returns no filters when nothing departed', () => {
    expect(membershipSweepFilters([])).toEqual([]);
  });

  it('splits very long source lists over several filters', () => {
    // Deletes travel in the URL query string; each filter must stay under a
    // conservative length budget rather than listing every source in one.
    const departed = Array.from(
      { length: 100 },
      (_, index) => `http://example.org/dataset/with/a/long/path/${index}`,
    );

    const filters = membershipSweepFilters(departed);

    expect(filters.length).toBeGreaterThan(1);
    expect(filters.every((filter) => filter.length < 3200)).toBe(true);
    // Every departed source appears in exactly one filter.
    const listed = filters.flatMap(
      (filter) => filter.match(/`([^`]+)`/g)?.length ?? 0,
    );
    expect(listed.reduce((sum, count) => sum + count, 0)).toBe(100);
  });
});
