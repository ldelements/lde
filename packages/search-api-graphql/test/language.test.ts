import { describe, expect, it } from 'vitest';
import { defaultLanguageOrder } from '../src/language.js';

describe('defaultLanguageOrder', () => {
  it('puts requested languages first, then the rest, then und', () => {
    expect(defaultLanguageOrder(['und', 'nl', 'en', 'fr'], ['en'])).toEqual([
      'en',
      'nl',
      'fr',
      'und',
    ]);
  });

  it('finds the primary language for a regional request', () => {
    // A browser’s `nl-NL` must surface the Dutch value, not whatever language
    // the document happens to list first.
    expect(defaultLanguageOrder(['en', 'nl'], ['nl-NL'])).toEqual(['nl', 'en']);
  });

  it('finds regional values for a primary-language request', () => {
    expect(defaultLanguageOrder(['en', 'nl-BE'], ['nl'])).toEqual([
      'nl-BE',
      'en',
    ]);
  });

  it('ranks the exact tag before a general one, without duplicates', () => {
    expect(
      defaultLanguageOrder(['en', 'en-GB', 'nl'], ['en-GB', 'en', 'nl']),
    ).toEqual(['en-GB', 'en', 'nl']);
  });
});
