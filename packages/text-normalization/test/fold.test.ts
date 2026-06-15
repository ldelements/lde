import { describe, expect, it } from 'vitest';
import { fold } from '../src/fold.js';

describe('fold', () => {
  it('transliterates non-decomposing letters', () => {
    // #1661: the flagship case — “Møhlmann” must fold to the same form a user
    // typing “Mohlmann” produces.
    expect(fold('Møhlmann')).toBe('mohlmann');
    expect(fold('Mohlmann')).toBe('mohlmann');
    expect(fold('Møhlmann')).toBe(fold('Mohlmann'));

    expect(fold('æther')).toBe('aether');
    expect(fold('œuvre')).toBe('oeuvre');
    expect(fold('Straße')).toBe('strasse');
    expect(fold('Þór')).toBe('thor');
    expect(fold('Łódź')).toBe('lodz');
  });

  it('strips decomposing diacritics via NFKD', () => {
    expect(fold('Coöperatieve')).toBe('cooperatieve');
    expect(fold('Cooperatieve')).toBe('cooperatieve');
    expect(fold('café')).toBe('cafe');
    expect(fold('Curaçao')).toBe('curacao');
    expect(fold('Ångström')).toBe('angstrom');
  });

  it('lowercases', () => {
    expect(fold('VERHAAL')).toBe('verhaal');
  });

  it('preserves word boundaries and punctuation', () => {
    expect(fold('Verhaal van Utrecht')).toBe('verhaal van utrecht');
    expect(fold('a-b/c')).toBe('a-b/c');
  });

  it('is idempotent', () => {
    for (const sample of ['Møhlmann', 'Coöperatieve', 'Straße', 'Þór', 'Łódź']) {
      expect(fold(fold(sample))).toBe(fold(sample));
    }
  });

  it('holds the index/query fold-symmetry invariant', () => {
    // A value stored folded at index time must equal the folded query a user
    // types for the un-folded original — regardless of diacritics or case.
    const pairs: ReadonlyArray<readonly [string, string]> = [
      ['Møhlmann', 'mohlmann'],
      ['CAFÉ', 'cafe'],
      ['Coöperatieve', 'cooperatieve'],
      ['Straße', 'strasse'],
    ];
    for (const [indexed, queried] of pairs) {
      expect(fold(indexed)).toBe(fold(queried));
    }
  });

  it('leaves already-folded ASCII untouched', () => {
    expect(fold('verhaal utrecht')).toBe('verhaal utrecht');
    expect(fold('')).toBe('');
  });
});
