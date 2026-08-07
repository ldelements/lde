import { describe, expect, it } from 'vitest';
import { defineSearchType } from '@lde/search';
import {
  SOURCE_FIELD,
  departedSources,
  membershipSweepFilters,
  sourceDocumentsFilter,
  provenanceField,
  staleDocumentsFilter,
  thisRunDocumentsFilter,
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

describe('provenanceField', () => {
  it('falls back to the private source field for a type declaring no dataset field', () => {
    const type = defineSearchType({
      name: 'Person',
      class: 'http://schema.org/Person',
      fields: [{ name: 'name', kind: 'keyword', output: true }],
    });

    expect(provenanceField(type)).toBe(SOURCE_FIELD);
  });

  it('is the declared dataset field, so the sweep reads the same column the facet does', () => {
    const type = defineSearchType({
      name: 'Person',
      class: 'http://schema.org/Person',
      fields: [
        {
          name: 'dataset',
          kind: 'reference',
          from: 'dataset',
          facetable: true,
        },
      ],
    });

    expect(provenanceField(type)).toBe('dataset');
  });

  it('falls back for an INTERNAL dataset field: the projection prunes it before the writer', () => {
    // Declared with no role, purely so a later derive can read it.
    const type = defineSearchType({
      name: 'Person',
      class: 'http://schema.org/Person',
      fields: [{ name: 'dataset', kind: 'reference', from: 'dataset' }],
    });

    expect(provenanceField(type)).toBe(SOURCE_FIELD);
  });
});

describe('staleDocumentsFilter', () => {
  it('filters on whichever field carries the provenance', () => {
    expect(
      staleDocumentsFilter('dataset', 'http://example.org/a', 'run-1'),
    ).toBe('dataset:=`http://example.org/a` && last_seen:!=`run-1`');
  });

  it('matches a source’s documents not touched by this run', () => {
    expect(
      staleDocumentsFilter(SOURCE_FIELD, 'http://example.org/a', 'run-1'),
    ).toBe('source:=`http://example.org/a` && last_seen:!=`run-1`');
  });

  it('escapes values that would break out of the filter quoting', () => {
    expect(
      staleDocumentsFilter(SOURCE_FIELD, 'http://example.org/`', 'run-1'),
    ).toBe('source:=`http://example.org/\\`` && last_seen:!=`run-1`');
  });
});

describe('sourceDocumentsFilter', () => {
  it('matches all of a source’s documents', () => {
    expect(sourceDocumentsFilter(SOURCE_FIELD, 'http://example.org/a')).toBe(
      'source:=`http://example.org/a`',
    );
  });
});

describe('thisRunDocumentsFilter', () => {
  it('matches only the documents this run wrote for a source (the inverse of stale)', () => {
    expect(
      thisRunDocumentsFilter(SOURCE_FIELD, 'http://example.org/a', 'run-1'),
    ).toBe('source:=`http://example.org/a` && last_seen:=`run-1`');
  });
});

describe('membershipSweepFilters', () => {
  it('combines departed sources into one membership filter', () => {
    expect(
      membershipSweepFilters(SOURCE_FIELD, [
        'http://example.org/a',
        'http://example.org/b',
      ]),
    ).toEqual(['source:=[`http://example.org/a`,`http://example.org/b`]']);
  });

  it('returns no filters when nothing departed', () => {
    expect(membershipSweepFilters(SOURCE_FIELD, [])).toEqual([]);
  });

  it('splits very long source lists over several filters', () => {
    // Deletes travel in the URL query string; each filter must stay under a
    // conservative length budget rather than listing every source in one.
    const departed = Array.from(
      { length: 100 },
      (_, index) => `http://example.org/dataset/with/a/long/path/${index}`,
    );

    const filters = membershipSweepFilters(SOURCE_FIELD, departed);

    expect(filters.length).toBeGreaterThan(1);
    expect(filters.every((filter) => filter.length < 3200)).toBe(true);
    // Every departed source appears in exactly one filter.
    const listed = filters.flatMap(
      (filter) => filter.match(/`([^`]+)`/g)?.length ?? 0,
    );
    expect(listed.reduce((sum, count) => sum + count, 0)).toBe(100);
  });
});
