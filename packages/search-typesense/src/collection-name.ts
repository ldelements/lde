import type { SearchType } from '@lde/search';
import { physicalNameTokens } from '@lde/search/adapter';

/**
 * The Typesense collection name for a {@link SearchType}, derived from its
 * logical `name` – the default every writer and the engine fall back to when a
 * deployment supplies none, so the write side and the read side share one
 * convention and cannot drift.
 *
 * The convention is Typesense’s own, as its docs write collection names:
 * snake_case, named after the plural of what the collection holds – `people`,
 * `companies`, `blog_articles`
 * ({@link https://typesense.org/docs/guide/organizing-collections.html |
 * Organizing collections}, which frames a collection as ‘similar to a table in
 * a relational database’). So `CreativeWork` → `creative_works`, `Person` →
 * `people`, `TVSeries` → `tv_series`. The engine-neutral half – the word split
 * and the inflection – is {@link physicalNameTokens}; only the `_` join and the
 * validation below are Typesense’s.
 *
 * A deployment that needs another name (an env prefix, a multi-tenant name, an
 * index that already exists) passes it explicitly instead; the override is
 * never validated here, since an existing collection’s name is the
 * deployment’s business.
 */
export function deriveCollectionName(searchType: SearchType): string {
  const name = physicalNameTokens(searchType).join('_');
  if (!DERIVED_COLLECTION_NAME.test(name)) {
    throw new Error(
      `Cannot derive a Typesense collection name from search type “${searchType.name}”: it yields “${name}”, which is not a legal collection name. Rename the type, or pass an explicit name.`,
    );
  }
  return name;
}

/**
 * What a *derived* name must look like. Typesense documents no collection-name
 * rules, but a name travels in the URL path of every collection call
 * (`/collections/:name`), so a character with URL meaning breaks that call
 * rather than being rejected at creation – `#` and `+` silently strand a
 * collection ({@link https://github.com/typesense/typesense/issues/548}). This
 * charset is the safe subset {@link physicalNameTokens} can produce anyway, so
 * the check is really a guard on the type name behind it: a `name` with no
 * alphanumerics at all (tokens `[]`, name `''`) is the case that reaches it.
 */
const DERIVED_COLLECTION_NAME = /^[a-z][a-z0-9_]*$/;
