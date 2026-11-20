/**
 * The value a {@link PhysicalFields.match label-match companion} stores for one
 * referent: the labels the referring graph states for it, then its id – so an
 * engine can search a facet’s values by what a person types and still tell
 * which referent a matching value is. `undefined` where no label has any text
 * to match: such a referent writes no value, and a facet query cannot find it.
 *
 * - **Punctuation becomes a space**, so every word of a label is a word of its
 *   own: an engine that strips punctuation inside a word would otherwise read
 *   “Regout/Sphinx)” as one word, which “sphinx” does not match.
 * - **The id sits behind a separator and a guard.** The separator is what
 *   {@link idOfLabelMatch} splits on; the guard starts the id’s word with
 *   characters nobody types, so a prefix-matching engine cannot match the id –
 *   “https” or a path segment would otherwise match every value.
 *
 * Several labels – several languages, or several names one graph states – are
 * one value, so a referent counts once per document whichever label matched.
 */
export function labelMatchValue(
  labels: readonly string[],
  id: string,
): string | undefined {
  const words = [
    ...new Set(
      labels
        .map((label) => label.replace(NOT_A_WORD, ' ').trim())
        .filter((label) => label !== ''),
    ),
  ];
  return words.length === 0
    ? undefined
    : `${words.join(' ')} ${SEPARATOR}${GUARD}${id}`;
}

/** The id a {@link labelMatchValue} pairs its labels with, or `undefined` for a
 *  value it did not write. */
export function idOfLabelMatch(value: string): string | undefined {
  const at = value.lastIndexOf(`${SEPARATOR}${GUARD}`);
  if (at === -1) {
    return undefined;
  }
  const id = value.slice(at + SEPARATOR.length + GUARD.length);
  return id === '' ? undefined : id;
}

/** A run of characters that is no part of a word: neither a letter, a mark
 *  (a decomposed accent) nor a number. */
const NOT_A_WORD = /[^\p{L}\p{M}\p{N}]+/gu;

/** The unit separator, which no label or IRI contains. */
const SEPARATOR = '\u001f';

/**
 * What the id’s word starts with: digits alternating with letters, which no
 * search for a label begins with, nor comes within the two typos a
 * prefix-matching engine may forgive – a guard one letter from a word would
 * match that word.
 */
const GUARD = '0q0x0z0';
