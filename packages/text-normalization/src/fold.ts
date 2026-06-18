/**
 * Transliteration map for letters that do NOT decompose under Unicode NFKD
 * normalization, so a plain combining-mark strip cannot fold them. Keys are
 * lowercase; uppercase variants are handled by lowercasing before lookup.
 *
 * The flagship case is ø (#1661: “Møhlmann” must be found by “Mohlmann”).
 * Decomposing letters (é, ö, å, ç, …) are intentionally NOT listed here —
 * NFKD + the combining-mark strip already fold them.
 */
const TRANSLITERATION_MAP: Readonly<Record<string, string>> = {
  ø: 'o',
  æ: 'ae',
  œ: 'oe',
  ß: 'ss',
  ð: 'd',
  þ: 'th',
  ł: 'l',
  đ: 'd',
  ħ: 'h',
  ŋ: 'ng',
  ı: 'i',
  ĸ: 'k',
};

/**
 * Version of the fold algorithm + transliteration map. Folded values are STORED
 * in the search index, so a change here changes index contents and must trigger
 * a full rebuild (it feeds the indexer’s schema fingerprint). Bump on any change
 * to {@link TRANSLITERATION_MAP} or {@link fold}’s normalization steps.
 */
export const FOLD_VERSION = 1;

const TRANSLITERATION_PATTERN = new RegExp(
  `[${Object.keys(TRANSLITERATION_MAP).join('')}]`,
  'g',
);

// Strip all Unicode nonspacing combining marks left behind by NFKD
// decomposition (e.g. the diaeresis in ö, the acute in é).
const COMBINING_MARKS_PATTERN = /\p{Mn}/gu;

/**
 * Fold a string into a diacritic- and case-insensitive normalized form, applied
 * IDENTICALLY at index time and query time (divergence = silent search misses).
 *
 * Steps: lowercase → transliterate non-decomposing letters → NFKD → strip
 * combining marks. Idempotent: `fold(fold(x)) === fold(x)`. Punctuation and
 * word boundaries are preserved; tokenization is left to the search engine.
 */
export function fold(input: string): string {
  return input
    .toLowerCase()
    .replace(TRANSLITERATION_PATTERN, (letter) => TRANSLITERATION_MAP[letter])
    .normalize('NFKD')
    .replace(COMBINING_MARKS_PATTERN, '');
}
