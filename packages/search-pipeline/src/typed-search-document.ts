import type { SearchDocument, SearchType } from '@lde/search';

/**
 * A projected {@link SearchDocument} paired with the {@link SearchType} it was
 * projected from.
 *
 * A search pipeline is N per-type stages writing to one terminal, and
 * {@link https://github.com/ldelements/lde/blob/main/docs/decisions/0009-route-a-whole-schema-projection-to-per-type-collections.md | ADR 9}’s
 * `searchIndexWriter` receives `write(dataset, items)` with no stage identity –
 * so the type travels with the item and the writer routes each document to the
 * engine run for its type by `searchType.class`. A stage mints the pair itself
 * (it was constructed for one type), so nothing is ever re-derived from the
 * document.
 *
 * It lives in `@lde/search-pipeline`, not `@lde/search`, because it exists only
 * because a pipeline terminal routes: that is glue, not projection. `@lde/search`
 * yields a bare {@link SearchDocument} and stays pipeline-free
 * ([ADR 13](https://github.com/ldelements/lde/blob/main/docs/decisions/0013-project-inside-the-batch-per-root-type.md)).
 */
export interface TypedSearchDocument {
  readonly searchType: SearchType;
  readonly document: SearchDocument;
}
