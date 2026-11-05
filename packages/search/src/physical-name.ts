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
 * **Throws rather than name the wrong container.** Dropping what it cannot
 * match is what lets `creative_work` tokenize like `CreativeWork`, but it would
 * just as quietly turn `Café` into `['cafs']` and `Musée` into `['mus', 'es']`
 * – a perfectly legal name for a container nobody meant. So a name is spellable
 * only when it is ASCII words and word separators, and only when it leaves at
 * least one word to name anything after; anything else throws here. This guard
 * lives with the split it protects, not in each adapter: an adapter cannot
 * derive a name without going through this function, so it cannot forget to
 * check – and `SearchType.name` is otherwise unvalidated
 * ({@link validateSearchType} rules on field names only). A deployment whose
 * type name this cannot spell passes its adapter an explicit name instead.
 */
export function physicalNameTokens(searchType: SearchType): readonly string[] {
  const { name } = searchType;
  if (!SPELLABLE_NAME.test(name)) {
    throw new Error(
      `Cannot name search type “${name}”: a physical name is derived from the type’s name, and this one carries characters outside ASCII words and word separators – deriving would silently drop them and name the wrong container. Rename the type, or give the adapter an explicit name.`,
    );
  }
  const tokens = (name.match(NAME_WORD_PATTERN) ?? []).map((word) =>
    word.toLowerCase(),
  );
  const last = tokens.at(-1);
  if (last === undefined) {
    throw new Error(
      `Cannot name search type “${name}”: its name carries no word to name a container after. Rename the type, or give the adapter an explicit name.`,
    );
  }
  return [...tokens.slice(0, -1), pluralize(last)];
}

/**
 * A name the split can spell without losing part of it: ASCII letters and
 * digits, plus the separators a name may already be written with (`creative
 * work`, `creative_work`, `creative-work` all tokenize like `CreativeWork`).
 * Deliberately narrower than what {@link NAME_WORD_PATTERN} would tolerate –
 * that one skips anything it does not match, which is precisely the silent
 * mangling this rejects.
 *
 * Matches the empty name too, on purpose: nothing about it is *unspellable*,
 * there is simply nothing to spell, which the no-word check below reports far
 * better than a complaint about characters it does not carry.
 */
const SPELLABLE_NAME = /^[A-Za-z0-9 _-]*$/;

/**
 * One word of a PascalCase/camelCase name, in precedence order: a run of
 * capitals not followed by a lowercase letter (an acronym – `DCAT` in
 * `DCATDataset`, `TV` in `TVSeries`); a capital starting an ordinary word; or a
 * lowercase run. Anything else (a separator, punctuation) matches nothing and
 * is dropped, so a name already written as `creative_work` or `creative-work`
 * tokenizes the same way.
 */
const NAME_WORD_PATTERN = /[A-Z]+(?![a-z])|[A-Z][a-z0-9]*|[a-z0-9]+/g;
