import { describe, expect, it } from 'vitest';
import {
  idOfLabelMatch,
  labelMatchText,
  labelMatchValue,
} from '../src/label-match.js';

const IRI = 'https://n2t.net/ark:/61567/abc';

describe('labelMatchValue', () => {
  it('writes every word of the labels, then the id behind a guard', () => {
    expect(labelMatchValue(['Timor (Petrus Regout/Sphinx)'], IRI)).toBe(
      `Timor Petrus Regout Sphinx \u001f0q0x0z0${IRI}`,
    );
  });

  it('keeps letters, accents and numbers, and each label once', () => {
    expect(
      labelMatchValue(['Sèvres-porselein', 'Sèvres-porselein', '1900'], IRI),
    ).toBe(`Sèvres porselein 1900 \u001f0q0x0z0${IRI}`);
  });

  it('writes nothing for labels with no word in them', () => {
    expect(labelMatchValue([], IRI)).toBeUndefined();
    expect(labelMatchValue([' ', '()'], IRI)).toBeUndefined();
  });
});

describe('idOfLabelMatch', () => {
  it('reads back the id a value pairs its labels with', () => {
    expect(idOfLabelMatch(labelMatchValue(['Boerenbont'], IRI) as string)).toBe(
      IRI,
    );
  });

  it('reads nothing from a value it did not write', () => {
    expect(idOfLabelMatch('Boerenbont')).toBeUndefined();
    expect(idOfLabelMatch('Boerenbont \u001f0q0x0z0')).toBeUndefined();
  });
});

describe('labelMatchText', () => {
  it('splits typed text into words as the values store them', () => {
    expect(labelMatchText(' Regout/Sphinx) ')).toBe('Regout Sphinx');
    expect(labelMatchText('(-)')).toBe('');
  });
});
