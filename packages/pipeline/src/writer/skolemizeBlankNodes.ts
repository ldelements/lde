import type {
  Quad,
  Term,
  Quad_Subject,
  Quad_Object,
  Quad_Graph,
} from '@rdfjs/types';
import { DataFactory } from 'n3';
import { hashSuffix, skolemIri } from '@lde/dataset';

const { namedNode, quad: makeQuad } = DataFactory;

/**
 * Rewrite every blank node in `quads` to a deterministic, dataset-scoped IRI,
 * leaving the quads otherwise unchanged.
 *
 * A served store such as the Dataset Knowledge Graph assembles one graph per
 * dataset by concatenating every per-dataset n-quads file into a single index
 * (`qlever index` over the `cat` of all files). Document-scoped blank-node
 * labels are not preserved across that concatenation: two datasets' `_:b0`
 * collapse into one node, silently fusing unrelated measurements, activities
 * and linksets across datasets (see ldelements/lde#478 and
 * netwerk-digitaal-erfgoed/dataset-knowledge-graph#352 / #420). IRIs are never
 * relabelled, so skolemising each blank node keeps distinct nodes distinct.
 *
 * Each blank node becomes `<dataset>/.well-known/skolem#<batch>-<label>`. The
 * dataset IRI rules out fusion across datasets; `<batch>`, a content hash of
 * this write's quads, rules out fusion across the separate writes that land in
 * one dataset's file — their labels both restart at `b0`, but writes carrying
 * different content hash differently. Two byte-identical writes collapse onto
 * the same IRIs, which is correct: they carry the same nodes.
 *
 * @param quads - The quads to rewrite, possibly containing blank nodes.
 * @param datasetIri - The dataset the quads belong to; scopes every minted IRI.
 * @returns The same quads with every blank node replaced by a skolem IRI.
 */
export function skolemizeBlankNodes(quads: Quad[], datasetIri: string): Quad[] {
  const base = `${datasetIri}/.well-known/skolem#${hashSuffix(fingerprint(quads))}`;
  const skolemize = (term: Term): Term =>
    term.termType === 'BlankNode'
      ? namedNode(skolemIri(base, term.value))
      : term;
  // A skolemised blank node is a NamedNode, valid in every term position, so the
  // casts hold: skolemize only rewrites blank nodes and leaves other terms as-is.
  return quads.map((quad) =>
    makeQuad(
      skolemize(quad.subject) as Quad_Subject,
      quad.predicate,
      skolemize(quad.object) as Quad_Object,
      skolemize(quad.graph) as Quad_Graph,
    ),
  );
}

/** A deterministic string identifying a write's quads, for a per-write IRI segment. */
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
