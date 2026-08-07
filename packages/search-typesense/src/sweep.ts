// Pure deletion planning shared by the rebuild writers: which documents leave
// a collection, expressed as source sets and Typesense filter strings. Kept
// free of the Typesense client so the logic is unit-testable. This module owns
// the private bookkeeping field names and resolves which field a collection
// carries its provenance in, so stamping and every filter that reads it can
// never disagree.

import { datasetField, isInternalField } from '@lde/search/adapter';
import type { SearchType } from '@lde/search';
import { escapeFilterValue } from './query-compiler.js';

/** The private field carrying the dataset IRI a document came from, for a type
 *  that declares none of its own – see {@link provenanceField}. */
export const SOURCE_FIELD = 'source';

/** The document field carrying the id of the run that last wrote a document. */
export const LAST_SEEN_FIELD = 'last_seen';

/**
 * The field a collection carries its documents’ dataset IRI in – the one the
 * membership sweep enumerates, filters and deletes by.
 *
 * A type that declares a field over the dataset
 * ({@link datasetField `from: 'dataset'`}) *is* its provenance: the writer keeps
 * its bookkeeping on that field rather than stamping a private one beside it,
 * so the facet, the label resolution, any `derive` and the sweep all read one
 * column that cannot drift. A type declaring nothing – or declaring the dataset
 * only as an *internal* field, which the projection prunes before the writer
 * ever sees it – falls back to the private {@link SOURCE_FIELD}, and behaves
 * exactly as it always has.
 */
export function provenanceField(searchType: SearchType): string {
  const declared = datasetField(searchType);
  return declared === undefined || isInternalField(declared)
    ? SOURCE_FIELD
    : declared.name;
}

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
 * @param sourceField The collection’s {@link provenanceField}
 * @param sourceIri The dataset IRI the documents carry in that field
 * @param runId The current run; documents it wrote carry it as `last_seen`
 */
export function staleDocumentsFilter(
  sourceField: string,
  sourceIri: string,
  runId: string,
): string {
  return `${sourceDocumentsFilter(sourceField, sourceIri)} && ${LAST_SEEN_FIELD}:!=${escapeFilterValue(runId)}`;
}

/**
 * Typesense filter matching all of a source’s documents, ready to drop a whole
 * source (a departed source’s membership sweep, or a Blue/green writer rolling
 * a failed dataset out of its not-yet-live collection).
 *
 * @param sourceField The collection’s {@link provenanceField}
 * @param sourceIri The dataset IRI the documents carry in that field
 */
export function sourceDocumentsFilter(
  sourceField: string,
  sourceIri: string,
): string {
  return `${sourceField}:=${escapeFilterValue(sourceIri)}`;
}

/**
 * Typesense filter matching the documents **this run** wrote for a source: the
 * inverse of {@link staleDocumentsFilter}. An In-place writer deletes these to
 * discard a source’s in-progress writes (the dump-fallback reset) without
 * touching its prior-run documents, which the success sweep or a failed run
 * still owns.
 *
 * @param sourceField The collection’s {@link provenanceField}
 * @param sourceIri The dataset IRI the documents carry in that field
 * @param runId The current run, stamped on its documents as `last_seen`
 */
export function thisRunDocumentsFilter(
  sourceField: string,
  sourceIri: string,
  runId: string,
): string {
  return `${sourceDocumentsFilter(sourceField, sourceIri)} && ${LAST_SEEN_FIELD}:=${escapeFilterValue(runId)}`;
}

/**
 * Typesense filters deleting every departed source’s documents, combined into
 * as few filters as fit: deletes travel in the URL query string, so each
 * filter stays under a conservative length budget rather than listing every
 * source in one string.
 *
 * @param sourceField The collection’s {@link provenanceField}
 * @param departed The departed source IRIs ({@link departedSources})
 */
export function membershipSweepFilters(
  sourceField: string,
  departed: readonly string[],
): string[] {
  const filters: string[] = [];
  let chunk: string[] = [];
  let chunkLength = 0;
  const flush = () => {
    if (chunk.length > 0) {
      filters.push(`${sourceField}:=[${chunk.join(',')}]`);
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
