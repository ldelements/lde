import type { LocalizedValue } from '@lde/search';
import { matchLanguage } from '@lde/search/adapter';

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
 * Default ordering: requested languages first (in request order, each matched
 * as a language range – `nl-NL` finds `nl` – most specific first), then the
 * remaining tagged languages, then untagged (`und`) last – so `[0]` is always
 * the best available value.
 */
export const defaultLanguageOrder: LanguageOrder = (available, accept) => {
  const requested = [
    ...new Set(
      accept.flatMap((language) => matchLanguage(language, available)),
    ),
  ];
  const rest = available.filter(
    (language) => !isUntagged(language) && !requested.includes(language),
  );
  const untagged = available.filter(isUntagged);
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
        language: isUntagged(language) ? null : language,
        value: text,
      });
    }
  }
  return result;
}

/** Whether a tag is `und` (undetermined); tags are case-insensitive. */
function isUntagged(language: string): boolean {
  return language.toLowerCase() === 'und';
}
