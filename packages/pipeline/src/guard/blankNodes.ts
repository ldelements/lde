import type { Quad } from '@rdfjs/types';
import type { QuadTransform } from '../stage.js';

/**
 * Why this guard exists.
 *
 * A file-based served store (e.g. the Dataset Knowledge Graph) rebuilds its
 * index by concatenating every per-dataset n-quads file and parsing the
 * concatenation as ONE RDF document (`qlever index` over
 * `find … -exec cat {} +`). Blank-node labels are only document-scoped, and the
 * pipeline emits deterministic labels (n3 `DataFactory.blankNode()` → `n3-N`,
 * the counter resets per dataset/run), so the same label recurs across files and
 * the indexer fuses those nodes into one — merging unrelated provenance,
 * measurements and linksets across datasets and runs. Named nodes never fuse.
 *
 * The invariant for any quads the pipeline writes into such a store is therefore:
 * NO blank nodes. Mint stable (skolem) IRIs instead — see `skolemIri` in
 * `@lde/dataset`. These helpers make that invariant testable and enforceable.
 *
 * See ldelements/lde#474 and netwerk-digitaal-erfgoed/dataset-knowledge-graph#352.
 */

/**
 * The distinct blank-node labels appearing in subject, object, or graph position
 * across `quads`. Empty when the quads are blank-node-free.
 */
export function blankNodes(quads: Iterable<Quad>): string[] {
  const offenders = new Set<string>();
  for (const quad of quads) {
    for (const term of [quad.subject, quad.object, quad.graph]) {
      if (term.termType === 'BlankNode') {
        offenders.add(term.value);
      }
    }
  }
  return [...offenders];
}

/**
 * Throw if any quad carries a blank node. Use in producer tests to lock in the
 * no-blank-nodes invariant (see module docs).
 */
export function assertNoBlankNodes(quads: Iterable<Quad>): void {
  const offenders = blankNodes(quads);
  if (offenders.length > 0) {
    throw new Error(
      `Output contains ${offenders.length} blank node(s), which fuse across ` +
        `datasets when a file-based store cat-indexes per-dataset files. ` +
        `Mint skolem IRIs instead (see skolemIri in @lde/dataset; ldelements/lde#474). ` +
        `First: ${offenders.slice(0, 10).join(', ')}`,
    );
  }
}

/**
 * A {@link QuadTransform} that passes quads through unchanged but throws on the
 * first blank node it sees. Insert it just before the writer to turn the
 * no-blank-nodes invariant into a hard pipeline failure (e.g. in a CI/staging
 * run) rather than a per-test opt-in.
 */
export function failOnBlankNodes<Context>(): QuadTransform<Context> {
  return async function* (quads) {
    for await (const quad of quads) {
      for (const term of [quad.subject, quad.object, quad.graph]) {
        if (term.termType === 'BlankNode') {
          throw new Error(
            `Blank node reached the writer (${term.value}); it would fuse ` +
              `across datasets in a cat-built index. Mint a skolem IRI instead ` +
              `(ldelements/lde#474): ${quad.subject.value} ${quad.predicate.value} …`,
          );
        }
      }
      yield quad;
    }
  };
}
