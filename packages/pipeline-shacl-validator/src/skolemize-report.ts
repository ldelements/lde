import type { Quad, Term } from '@rdfjs/types';
import { hashSuffix, skolemIri } from '@lde/dataset';
// @ts-expect-error -- rdf-ext has no type declarations.
import rdf from 'rdf-ext';

/**
 * Rewrite every blank node in a shacl-engine validation report to a
 * deterministic, dataset-scoped IRI, leaving the report otherwise unchanged.
 *
 * shacl-engine emits the `sh:ValidationReport`, every `sh:ValidationResult` and
 * any anonymous `sh:sourceShape`/`sh:value`/`sh:detail` as blank nodes. When a
 * file-based served store such as the Dataset Knowledge Graph concatenates every
 * per-dataset n-quads file into one index (`qlever index` over the `cat` of all
 * files), document-scoped blank-node labels recur across files and fuse one
 * dataset's results into another's — a cross-graph traversal can then reach a
 * foreign dataset's violations (see ldelements/lde#478 and #474, and
 * netwerk-digitaal-erfgoed/dataset-knowledge-graph#352).
 *
 * Each blank node becomes `<dataset>/.well-known/shacl#<batch>-<label>`. The
 * dataset IRI rules out fusion across datasets; `<batch>`, a hash of this
 * report's quads, rules out fusion across the separate `validate()` batches that
 * land in one dataset's validation graph — their labels both restart at `b1`,
 * but a batch carrying different violations hashes differently. Two batches with
 * byte-identical reports collapse onto the same IRIs, which is correct: they are
 * the same violations.
 *
 * @param quads - The report quads (`report.dataset`), possibly with blank nodes.
 * @param datasetIri - The dataset the report is about; scopes every minted IRI.
 * @returns The same quads with every blank node replaced by a skolem IRI.
 */
export function skolemizeReport(
  quads: Iterable<Quad>,
  datasetIri: string,
): Quad[] {
  const reportQuads = [...quads];
  // Fold the per-batch hash into the base, then let skolemIri append `-<label>`,
  // matching the skolems minted for provenance and distribution reports (#474).
  const base = `${datasetIri}/.well-known/shacl#${hashSuffix(fingerprint(reportQuads))}`;
  const skolemize = (term: Term): Term =>
    term.termType === 'BlankNode'
      ? rdf.namedNode(skolemIri(base, term.value))
      : term;
  return reportQuads.map((quad) =>
    rdf.quad(
      skolemize(quad.subject),
      quad.predicate,
      skolemize(quad.object),
      skolemize(quad.graph),
    ),
  );
}

/** A deterministic string identifying a report, for use as a per-batch IRI segment. */
function fingerprint(quads: Quad[]): string {
  return quads
    .map(
      (quad) =>
        `${termKey(quad.subject)} ${quad.predicate.value} ${termKey(quad.object)}`,
    )
    .sort()
    .join('\n');
}

function termKey(term: Term): string {
  switch (term.termType) {
    case 'BlankNode':
      return `_:${term.value}`;
    case 'Literal':
      return `"${term.value}"^^<${term.datatype.value}>@${term.language}`;
    default:
      return `<${term.value}>`;
  }
}
