import { describe, expect, it } from 'vitest';
import { matchLanguage } from '../src/language.js';

describe('matchLanguage', () => {
  it('matches an exact tag', () => {
    expect(matchLanguage('nl', ['en', 'nl'])).toEqual(['nl']);
  });

  it('finds a declared primary subtag for a regional tag', () => {
    expect(matchLanguage('nl-NL', ['en', 'nl'])).toEqual(['nl']);
  });

  it('finds regional tags for a primary subtag, in candidate order', () => {
    expect(matchLanguage('nl', ['nl-NL', 'en', 'nl-BE'])).toEqual([
      'nl-NL',
      'nl-BE',
    ]);
  });

  it('ranks the exact tag first, then truncations, then extensions', () => {
    expect(
      matchLanguage('zh-Hant', ['zh-Hant-TW', 'zh', 'zh-Hant', 'en']),
    ).toEqual(['zh-Hant', 'zh', 'zh-Hant-TW']);
    expect(matchLanguage('zh-Hant-TW', ['zh', 'zh-Hant'])).toEqual([
      'zh-Hant',
      'zh',
    ]);
  });

  it('lets the exact tag win where general and specific sit side by side', () => {
    expect(matchLanguage('en', ['en-GB', 'en'])).toEqual(['en', 'en-GB']);
    expect(matchLanguage('en-GB', ['en', 'en-GB'])).toEqual(['en-GB', 'en']);
  });

  it('falls back to a sibling region after every closer match', () => {
    expect(matchLanguage('nl-NL', ['nl-BE', 'en', 'nl'])).toEqual([
      'nl',
      'nl-BE',
    ]);
    expect(
      matchLanguage('zh-Hant-TW', ['zh-Hans', 'zh-Hant-HK', 'zh-TW']),
    ).toEqual(['zh-Hant-HK', 'zh-Hans', 'zh-TW']);
  });

  it('does not match another language', () => {
    expect(matchLanguage('nl-NL', ['en', 'fr-BE'])).toEqual([]);
  });

  it('compares case-insensitively and returns the candidate as given', () => {
    expect(matchLanguage('pt-br', ['PT', 'pt-BR'])).toEqual(['pt-BR', 'PT']);
  });

  it('compares whole subtags, not string prefixes', () => {
    expect(matchLanguage('e', ['en'])).toEqual([]);
  });

  it('matches und only to und', () => {
    expect(matchLanguage('und', ['nl', 'und'])).toEqual(['und']);
    expect(matchLanguage('nl', ['und'])).toEqual([]);
  });
});
