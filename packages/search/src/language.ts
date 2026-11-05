/**
 * The entries of `candidates` that language tag `tag` matches, best first, as
 * the entries themselves (so a caller can index back into `candidates`).
 *
 * Tags are compared per BCP-47 subtag and case-insensitively, as language
 * ranges (RFC 4647). A candidate matches when it shares the tag’s primary
 * language, ranked:
 *
 * 1. the exact tag (`nl-NL` for `nl-NL`);
 * 2. the tag’s truncations, most specific first – RFC 4647 lookup, so a
 *    request for `nl-NL` finds a declared `nl`;
 * 3. the tags it is a prefix of, in `candidates` order – RFC 4647 basic
 *    filtering, so a range `nl` finds `nl-NL` and `nl-BE`;
 * 4. the remaining tags of the same language, longest shared prefix first, so
 *    a request for `nl-NL` still finds `nl-BE` rather than another language.
 *
 * The exact match therefore still wins where a general and a specific tag sit
 * side by side (`en` and `en-GB`). `und`, the untagged bucket, matches nothing
 * but `und`.
 */
export function matchLanguage(
  tag: string,
  candidates: readonly string[],
): string[] {
  const subtags = tag.toLowerCase().split('-');
  const ranked: { candidate: string; kind: number; closeness: number }[] = [];
  for (const candidate of candidates) {
    const candidateSubtags = candidate.toLowerCase().split('-');
    const shared = sharedPrefixLength(subtags, candidateSubtags);
    const exact =
      shared === subtags.length && shared === candidateSubtags.length;
    if (shared === 0 || (subtags[0] === 'und' && !exact)) {
      continue;
    }
    const kind = exact
      ? 0
      : shared === candidateSubtags.length
        ? 1
        : shared === subtags.length
          ? 2
          : 3;
    // Extensions keep candidate order; truncations and siblings rank by how
    // much of the tag they share.
    ranked.push({ candidate, kind, closeness: kind === 2 ? 0 : shared });
  }
  return ranked
    .sort(
      (left, right) =>
        left.kind - right.kind || right.closeness - left.closeness,
    )
    .map(({ candidate }) => candidate);
}

function sharedPrefixLength(
  left: readonly string[],
  right: readonly string[],
): number {
  let length = 0;
  while (
    length < left.length &&
    length < right.length &&
    left[length] === right[length]
  ) {
    length++;
  }
  return length;
}
