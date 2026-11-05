import { canonicalizeIri, type NamespaceAlias } from '../namespaceAlias.js';
import type { QuadTransform } from '../stage.js';
import type { BeforeStageWriteContext, PipelinePlugin } from '../pipeline.js';
import type { Quad, Term } from '@rdfjs/types';
import { DataFactory } from 'n3';

const { namedNode, quad } = DataFactory;

export interface NamespaceNormalizationOptions {
  /** Namespace URI prefix to match (e.g. `http://schema.org/`). */
  from: string;
  /** Namespace URI prefix to replace it with (e.g. `https://schema.org/`). */
  to: string;
}

/**
 * Creates a {@link QuadTransform} that rewrites every IRI in the
 * {@link NamespaceNormalizationOptions.from} namespace to
 * {@link NamespaceNormalizationOptions.to} — in subject, predicate and object
 * position alike.
 *
 * This is a blanket, vocabulary-agnostic rewrite: it normalizes the namespace
 * wherever it appears, with no knowledge of VoID or any other RDF shape. Use it
 * to standardize a namespace across a dataset's own quads (for example
 * `http://schema.org/` → `https://schema.org/` when mapping instance data to an
 * application profile). Merging VoID partition _nodes_ that two namespace
 * variants produced is a separate, shape-aware concern handled by
 * `@lde/pipeline-void`.
 */
export function namespaceNormalizationTransform(
  options: NamespaceNormalizationOptions,
): QuadTransform<BeforeStageWriteContext> {
  const namespaceAliases: NamespaceAlias[] = [
    { canonical: options.to, alias: options.from },
  ];
  return (quads) => normalize(quads, namespaceAliases);
}

/**
 * A generic {@link PipelinePlugin} that normalizes a namespace prefix across a
 * stage's output via {@link PipelinePlugin.beforeStageWrite}. Rewrites every
 * matching IRI, in any term position; see
 * {@link namespaceNormalizationTransform}.
 */
export function namespaceNormalizationPlugin(
  options: NamespaceNormalizationOptions,
): PipelinePlugin {
  return {
    name: 'namespace-normalization',
    beforeStageWrite: namespaceNormalizationTransform(options),
  };
}

function normalizeTerm<T extends Term>(
  term: T,
  namespaceAliases: readonly NamespaceAlias[],
): T {
  if (term.termType !== 'NamedNode') {
    return term;
  }
  const canonical = canonicalizeIri(term.value, namespaceAliases);
  return (canonical === term.value ? term : namedNode(canonical)) as T;
}

async function* normalize(
  quads: AsyncIterable<Quad>,
  namespaceAliases: readonly NamespaceAlias[],
): AsyncIterable<Quad> {
  for await (const q of quads) {
    const subject = normalizeTerm(q.subject, namespaceAliases);
    const predicate = normalizeTerm(q.predicate, namespaceAliases);
    const object = normalizeTerm(q.object, namespaceAliases);
    if (
      subject === q.subject &&
      predicate === q.predicate &&
      object === q.object
    ) {
      yield q;
    } else {
      yield quad(subject, predicate, object, q.graph);
    }
  }
}
