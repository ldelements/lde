// Pure sweep planning for the In-place Rebuild writer: which documents leave
// the index, expressed as source sets and Typesense filter strings. Kept free
// of the Typesense client so deletion logic is unit-testable. This module
// owns the bookkeeping field names, so stamping (in-place-rebuild) and
// sweeping can never disagree on them.

import { escapeFilterValue } from './query-compiler.js';

/** The document field carrying the dataset IRI a document came from. */
export const SOURCE_FIELD = 'source';

/** The document field carrying the id of the run that last wrote a document. */
export const LAST_SEEN_FIELD = 'last_seen';

/**
 * Sources whose documents must leave the index: indexed, but no longer part
 * of the run’s selection. Selection is membership, not processing – a dataset
 * skipped as unchanged is still selected, so its documents survive.
 *
 * @param indexedSources Source IRIs present in the collection
 * @param selectedSources Source IRIs the run’s selector produced
 */
export function departedSources(
  indexedSources: Iterable<string>,
  selectedSources: Iterable<string>,
): string[] {
  const selected = new Set(selectedSources);
  return [...indexedSources].filter((source) => !selected.has(source));
}

/**
 * Typesense filter matching a source’s documents that this run did not touch:
 * everything the source no longer contains, ready for a per-source sweep.
 *
 * @param sourceIri The dataset IRI stamped on the documents as `source`
 * @param runId The current run; documents it wrote carry it as `last_seen`
 */
export function staleDocumentsFilter(sourceIri: string, runId: string): string {
  return `${sourceDocumentsFilter(sourceIri)} && ${LAST_SEEN_FIELD}:!=${escapeFilterValue(runId)}`;
}

/**
 * Typesense filter matching all of a source’s documents, ready for a
 * membership sweep of a departed source.
 *
 * @param sourceIri The dataset IRI stamped on the documents as `source`
 */
export function sourceDocumentsFilter(sourceIri: string): string {
  return `${SOURCE_FIELD}:=${escapeFilterValue(sourceIri)}`;
}

/**
 * Typesense filters deleting every departed source’s documents, combined into
 * as few filters as fit: deletes travel in the URL query string, so each
 * filter stays under a conservative length budget rather than listing every
 * source in one string.
 *
 * @param departed The departed source IRIs ({@link departedSources})
 */
export function membershipSweepFilters(departed: readonly string[]): string[] {
  const filters: string[] = [];
  let chunk: string[] = [];
  let chunkLength = 0;
  const flush = () => {
    if (chunk.length > 0) {
      filters.push(`${SOURCE_FIELD}:=[${chunk.join(',')}]`);
      chunk = [];
      chunkLength = 0;
    }
  };
  for (const source of departed) {
    const escaped = escapeFilterValue(source);
    if (chunkLength + escaped.length > MAX_FILTER_VALUES_LENGTH) {
      flush();
    }
    chunk.push(escaped);
    chunkLength += escaped.length + 1;
  }
  flush();
  return filters;
}

/** Stay well under Typesense’s ~4000-char URL query-string limit per delete. */
const MAX_FILTER_VALUES_LENGTH = 3000;
