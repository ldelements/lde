import { pluralize } from 'inflection';
import type { SearchType } from './schema.js';

/**
 * The engine-neutral word tokens an adapter formats into the physical name of a
 * {@link SearchType}’s container – a Typesense collection, an Elasticsearch or
 * OpenSearch index: the type’s `name` split into words, lowercased, with the
 * last word pluralized (`CreativeWork` → `['creative', 'works']`).
 *
 * Both engines document the same convention – name a container after the plural
 * of what it holds – and differ only in how they join the words: Typesense
 * snake_case (`blog_articles`), Elasticsearch/OpenSearch kebab-case
 * (`blog-articles`). So the split and the inflection are shared here, and only
 * the join and the engine’s own legality rules live in the adapter – which is
 * why this returns tokens rather than a formatted name, and why it is spelled
 * neutrally (‘container’, not ‘collection’ or ‘index’).
 *
 * Acronyms stay whole (`DCATDataset` → `['dcat', 'datasets']`, `TVSeries` →
 * `['tv', 'series']`), which is why the split is hand-rolled rather than
 * delegated to an inflector’s `underscore`/`tableize` – those split on every
 * capital (`t_v_series`).
 *
 * Pluralization is a real inflector, so irregular and invariant nouns land the
 * way the engines’ own docs write them (`Person` → `people`, `TVSeries` →
 * `tv_series`, `Analysis` → `analyses`) rather than as the non-words regular
 * rules produce (`serieses`, `analysises`). An already-plural name is
 * idempotent (`People` → `people`).
 *
 * Returns an empty array when `name` carries no alphanumerics at all; the
 * adapter decides what that means, since only it knows its engine’s rules.
 */
export function physicalNameTokens(searchType: SearchType): readonly string[] {
  const words = searchType.name.match(NAME_WORD_PATTERN) ?? [];
  const tokens = words.map((word) => word.toLowerCase());
  const last = tokens.at(-1);
  return last === undefined ? [] : [...tokens.slice(0, -1), pluralize(last)];
}

/**
 * One word of a PascalCase/camelCase name, in precedence order: a run of
 * capitals not followed by a lowercase letter (an acronym – `DCAT` in
 * `DCATDataset`, `TV` in `TVSeries`); a capital starting an ordinary word; or a
 * lowercase run. Anything else (a separator, punctuation) matches nothing and
 * is dropped, so a name already written as `creative_work` or `creative-work`
 * tokenizes the same way.
 */
const NAME_WORD_PATTERN = /[A-Z]+(?![a-z])|[A-Z][a-z0-9]*|[a-z0-9]+/g;
