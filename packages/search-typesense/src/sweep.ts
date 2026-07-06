// Pure sweep planning for the In-place Rebuild writer: which documents leave
// the index, expressed as source sets and Typesense filter strings. Kept free
// of the Typesense client so deletion logic is unit-testable.

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
  return `${sourceDocumentsFilter(sourceIri)} && last_seen:!=${quote(runId)}`;
}

/**
 * Typesense filter matching all of a source’s documents, ready for a
 * membership sweep of a departed source.
 *
 * @param sourceIri The dataset IRI stamped on the documents as `source`
 */
export function sourceDocumentsFilter(sourceIri: string): string {
  return `source:=${quote(sourceIri)}`;
}

/**
 * Quote a filter value for Typesense with backticks, rejecting values that
 * would break out of the quoting.
 */
function quote(value: string): string {
  if (value.includes('`')) {
    throw new Error(`Filter value must not contain a backtick, got “${value}”`);
  }
  return `\`${value}\``;
}
