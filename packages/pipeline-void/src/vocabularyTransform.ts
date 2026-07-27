import type { ReaderContext, QuadTransform } from '@lde/pipeline';
import type { Distribution } from '@lde/dataset';
import type { Quad } from '@rdfjs/types';
import prefixes from '@zazuko/prefixes';
import { DataFactory } from 'n3';
import { _void } from '@tpluscode/rdf-ns-builders';

const { namedNode, quad } = DataFactory;

export const defaultVocabularies: readonly string[] = [
  ...new Set(Object.values(prefixes)),
];

/**
 * Creates a {@link QuadTransform} that passes through all quads from a stage's
 * reader output and appends `void:vocabulary` triples for detected
 * vocabulary prefixes.
 *
 * Inspects quads with predicate `void:property` to detect known vocabulary
 * namespace prefixes, then yields the corresponding `void:vocabulary` quads
 * after the reader output has been consumed.
 *
 * Attach it to the `entity-properties.rq` stage's reader – directly via
 * {@link detectVocabularies} or through the `transforms` map of
 * {@link voidStages}.
 *
 * With per-property iteration the transform sees one batch at a time, so it
 * remembers which vocabularies it already emitted per {@link Distribution}
 * and yields each `void:vocabulary` quad only once per stage run. The memory
 * is keyed weakly on the distribution instance – one per run – so a fallback
 * re-run of the same dataset (a fresh distribution) starts clean.
 */
export function withVocabularies(
  vocabularies: readonly string[] = defaultVocabularies,
): QuadTransform<ReaderContext> {
  const emittedPerRun = new WeakMap<Distribution, Set<string>>();
  return (quads, { dataset, distribution }) => {
    let emitted = emittedPerRun.get(distribution);
    if (!emitted) {
      emitted = new Set();
      emittedPerRun.set(distribution, emitted);
    }
    return appendVocabularies(
      quads,
      dataset.iri.toString(),
      vocabularies,
      emitted,
    );
  };
}

async function* appendVocabularies(
  quads: AsyncIterable<Quad>,
  datasetIri: string,
  vocabularies: readonly string[],
  emitted: Set<string>,
): AsyncIterable<Quad> {
  const detectedVocabularies = new Set<string>();

  for await (const q of quads) {
    yield q;

    if (q.predicate.equals(_void.property)) {
      const propertyUri = q.object.value;
      for (const ns of vocabularies) {
        if (propertyUri.startsWith(ns)) {
          detectedVocabularies.add(ns);
          break;
        }
      }
    }
  }

  const datasetNode = namedNode(datasetIri);
  for (const vocabUri of detectedVocabularies) {
    if (emitted.has(vocabUri)) {
      continue;
    }
    emitted.add(vocabUri);
    yield quad(datasetNode, _void.vocabulary, namedNode(vocabUri));
  }
}
