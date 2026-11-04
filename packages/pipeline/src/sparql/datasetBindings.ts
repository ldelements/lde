import { Dataset, Distribution } from '@lde/dataset';
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
 * Dataset-level bindings as groups of rows. Rows in one group are alternatives
 * for the same variables; different groups say nothing about each other, so a
 * query only pays for a combination of them if it needs one – see
 * {@link injectDatasetBindings}. A group may be empty.
 */
export type DatasetBindings = VariableBindings[][];

/**
 * Always-on bindings derived from a {@link Dataset} – see
 * {@link DATASET_BINDING_VARIABLES}. The single-valued properties share one
 * group; `datasetLanguage` and `datasetPublisherName` each form their own,
 * because a language and a publisher name say nothing about each other.
 */
export function predefinedDatasetBindings(dataset: Dataset): DatasetBindings {
  const base: VariableBindings = { dataset: namedNode(dataset.iri.toString()) };

  if (dataset.publisher) {
    base.datasetPublisher = namedNode(dataset.publisher.iri.toString());
  }
  if (dataset.license) {
    base.datasetLicense = namedNode(dataset.license.toString());
  }

  const languages = dataset.language.map((language) => ({
    datasetLanguage: literal(language),
  }));
  const publisherNames = Object.entries(dataset.publisher?.name ?? {}).map(
    ([language, name]) => ({ datasetPublisherName: literal(name, language) }),
  );

  return [[base], languages, publisherNames];
}

/**
 * The {@link predefinedDatasetBindings} plus a provider's rows as one more
 * group. A variable the rows bind replaces the predefined binding of that name.
 */
export function datasetBindingsFor(
  dataset: Dataset,
  customRows: VariableBindings[],
): DatasetBindings {
  const customVariables = new Set(customRows.flatMap(Object.keys));
  const predefined = predefinedDatasetBindings(dataset).map((rows) =>
    rows.map((row) =>
      Object.fromEntries(
        Object.entries(row).filter(([name]) => !customVariables.has(name)),
      ),
    ),
  );

  return [...predefined, customRows];
}

/**
 * Extension point for per-dataset bindings this library can't know about
 * (e.g. a caller-local `rdf:type` read from a side file). Mirrors
 * {@link Reader} and {@link ItemSelector}. The returned rows form one group:
 * return values that must appear in one solution together in the same row.
 */
export interface DatasetBindingsProvider {
  bindings(
    dataset: Dataset,
    distribution: Distribution,
  ): VariableBindings[] | Promise<VariableBindings[]>;
}
