import { describe, expect, it } from 'vitest';
import { defaultLanguageOrder, toLanguageStrings } from '../src/language.js';

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

  it('ranks und last in any case', () => {
    expect(defaultLanguageOrder(['UND', 'nl'], [])).toEqual(['nl', 'UND']);
  });
});

describe('toLanguageStrings', () => {
  it('serves und in any case as untagged', () => {
    expect(toLanguageStrings({ UND: ['x'] }, [], defaultLanguageOrder)).toEqual(
      [{ language: null, value: 'x' }],
    );
  });

  it('skips a language that a custom order adds but the value lacks', () => {
    expect(
      toLanguageStrings({ nl: ['Titel'] }, [], () => ['en', 'nl']),
    ).toEqual([{ language: 'nl', value: 'Titel' }]);
  });
});
