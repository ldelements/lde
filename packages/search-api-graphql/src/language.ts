import type { LocalizedValue } from '@lde/search';

/** One entry of the surface’s best-first `[LanguageString!]!`. `language` is null
 *  for untagged (`und`) values; `[0]` is the value to display and `[0].language`
 *  is the language actually served (the per-field `Content-Language`). */
export interface LanguageString {
  readonly language: string | null;
  readonly value: string;
}

/** Orders a localized value’s available languages against the request. */
export type LanguageOrder = (
  available: readonly string[],
  accept: readonly string[],
) => readonly string[];

/**
 * Default ordering: requested languages first (in request order), then the
 * remaining tagged languages, then untagged (`und`) last — so `[0]` is always the
 * best available value.
 */
export const defaultLanguageOrder: LanguageOrder = (available, accept) => {
  const requested = accept.filter((language) => available.includes(language));
  const rest = available.filter(
    (language) => language !== 'und' && !requested.includes(language),
  );
  const untagged = available.includes('und') ? ['und'] : [];
  return [...requested, ...rest, ...untagged];
};

/** Flatten a language map into a best-first `LanguageString` list. */
export function toLanguageStrings(
  value: LocalizedValue,
  accept: readonly string[],
  order: LanguageOrder,
): LanguageString[] {
  const result: LanguageString[] = [];
  for (const language of order(Object.keys(value), accept)) {
    for (const text of value[language] ?? []) {
      result.push({
        language: language === 'und' ? null : language,
        value: text,
      });
    }
  }
  return result;
}
