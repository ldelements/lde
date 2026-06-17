import type { QuadTransform } from '../stage.js';
import type { PipelinePlugin } from '../pipeline.js';
import type { Dataset } from '@lde/dataset';
import type { Quad } from '@rdfjs/types';
import { DataFactory } from 'n3';
import { _void } from '@tpluscode/rdf-ns-builders';

const { namedNode, quad } = DataFactory;

export interface NamespaceNormalizationOptions {
  /** Namespace URI prefix to match (e.g. `http://schema.org/`). */
  from: string;
  /** Namespace URI prefix to replace with (e.g. `https://schema.org/`). */
  to: string;
}

/**
 * Creates a QuadTransform that rewrites namespace prefixes in `void:class` and
 * `void:property` quad objects from {@link NamespaceNormalizationOptions.from}
 * to {@link NamespaceNormalizationOptions.to}.
 *
 * `void:vocabulary` quads are left unchanged so consumers can see which
 * namespace the source dataset actually uses.
 */
export function namespaceNormalizationTransform(
  options: NamespaceNormalizationOptions,
): QuadTransform<{ dataset: Dataset }> {
  return (quads) => normalizeNamespace(quads, options);
}

/**
 * Pipeline plugin that normalizes namespace prefixes in `void:class` and
 * `void:property` quad objects.
 *
 * `void:vocabulary` quads are left unchanged so consumers can see which
 * namespace the source dataset actually uses.
 */
export function namespaceNormalizationPlugin(
  options: NamespaceNormalizationOptions,
): PipelinePlugin {
  return {
    name: 'namespace-normalization',
    beforeStageWrite: namespaceNormalizationTransform(options),
  };
}

async function* normalizeNamespace(
  quads: AsyncIterable<Quad>,
  { from, to }: NamespaceNormalizationOptions,
): AsyncIterable<Quad> {
  for await (const q of quads) {
    if (
      (q.predicate.equals(_void.class) || q.predicate.equals(_void.property)) &&
      q.object.termType === 'NamedNode' &&
      q.object.value.startsWith(from)
    ) {
      yield quad(
        q.subject,
        q.predicate,
        namedNode(to + q.object.value.slice(from.length)),
        q.graph,
      );
    } else {
      yield q;
    }
  }
}
