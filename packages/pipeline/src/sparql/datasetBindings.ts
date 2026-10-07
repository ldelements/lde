import { Dataset, Distribution, assertSafeIri } from '@lde/dataset';
import { DataFactory } from 'n3';
import type { VariableBindings } from './reader.js';

const { namedNode, literal } = DataFactory;

/** Reserved variable names – see {@link predefinedDatasetBindings}. */
export const DATASET_BINDING_VARIABLES = [
  'dataset',
  'datasetPublisher',
  'datasetPublisherName',
  'datasetLicense',
  'datasetLanguage',
] as const;

/**
 * Cross-products rows with one more multi-valued dimension. Empty `values`
 * passes rows through unchanged, so `key` is never set – the variable stays
 * unbound rather than becoming `UNDEF`.
 */
function expandMultiValued(
  rows: VariableBindings[],
  key: string,
  values: readonly VariableBindings[string][],
): VariableBindings[] {
  if (values.length === 0) return rows;
  return rows.flatMap((row) =>
    values.map((value) => ({ ...row, [key]: value })),
  );
}

/**
 * Always-on bindings derived from a {@link Dataset} – see
 * {@link DATASET_BINDING_VARIABLES}.
 *
 * `datasetLanguage` and `datasetPublisherName` are independent multi-valued
 * dimensions, expanded as a cross product (2 languages × 2 name translations
 * = 4 rows), so a `CONSTRUCT` emits one triple per combination – this also
 * repeats any other, non-varying triple in the query once per combination;
 * enable {@link SparqlConstructReaderOptions.deduplicate} for that.
 */
export function predefinedDatasetBindings(
  dataset: Dataset,
): VariableBindings[] {
  assertSafeIri(dataset.iri.toString());
  const base: VariableBindings = { dataset: namedNode(dataset.iri.toString()) };

  if (dataset.publisher) {
    assertSafeIri(dataset.publisher.iri.toString());
    base.datasetPublisher = namedNode(dataset.publisher.iri.toString());
  }
  if (dataset.license) {
    assertSafeIri(dataset.license.toString());
    base.datasetLicense = namedNode(dataset.license.toString());
  }

  let rows: VariableBindings[] = [base];
  rows = expandMultiValued(
    rows,
    'datasetLanguage',
    dataset.language.map((lang) => literal(lang)),
  );
  rows = expandMultiValued(
    rows,
    'datasetPublisherName',
    dataset.publisher
      ? Object.entries(dataset.publisher.name).map(([lang, name]) =>
          literal(name, lang),
        )
      : [],
  );

  return rows;
}

/**
 * Extension point for per-dataset bindings this library can't know about
 * (e.g. a caller-local `rdf:type` read from a side file). Mirrors
 * {@link Reader} and {@link ItemSelector}.
 */
export interface DatasetBindingsProvider {
  bindings(
    dataset: Dataset,
    distribution: Distribution,
  ): VariableBindings[] | Promise<VariableBindings[]>;
}
