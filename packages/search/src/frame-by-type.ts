import type { Quad } from '@rdfjs/types';
import jsonld from 'jsonld';

const RDF_TYPE = 'http://www.w3.org/1999/02/22-rdf-syntax-ns#type';

/** A framed JSON-LD node (full-IRI keys); the engine-agnostic search IR. */
export type FramedSubject = Record<string, unknown>;

const FRAME_OPTIONS = { omitGraph: false, embed: '@always' as const };

/**
 * Frame CONSTRUCT quads into one JSON-LD node per subject of `rootType`. Each
 * root subject’s own triples plus the one-hop nodes it references (e.g. nested
 * publisher/distribution resources) are framed independently and yielded one at
 * a time, so memory stays flat at scale — whole-graph `jsonld.frame()` is
 * ~O(N²). Duplicate triples are collapsed first because some SPARQL engines
 * (e.g. QLever) do not dedupe CONSTRUCT output. The caller supplies the root
 * type, keeping the framing domain-agnostic; the frame carries no `@context`, so
 * framed keys are full predicate IRIs.
 */
export async function* frameByType(
  quads: readonly Quad[],
  rootType: string,
): AsyncIterable<FramedSubject> {
  const frame = { '@type': rootType };
  for (const subgraph of groupByRoot(quads, rootType)) {
    const expanded = await jsonld.fromRDF(subgraph);
    const framed = await jsonld.frame(expanded, frame, FRAME_OPTIONS);
    const node = (framed['@graph'] as FramedSubject[] | undefined)?.[0];
    if (node !== undefined) {
      yield node;
    }
  }
}

/** One self-contained quad subgraph per root subject: its own (deduped) triples
 *  plus the triples of the one-hop IRI or blank nodes it references. */
function groupByRoot(quads: readonly Quad[], rootType: string): Quad[][] {
  const bySubject = new Map<string, Quad[]>();
  const rootIris = new Set<string>();
  const seen = new Set<string>();
  for (const quad of quads) {
    const key = `${quad.subject.value} ${quad.predicate.value} ${quad.object.value} ${quad.object.termType === 'Literal' ? quad.object.language || quad.object.datatype.value : ''}`;
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    const subject = quad.subject.value;
    const owned = bySubject.get(subject);
    if (owned === undefined) {
      bySubject.set(subject, [quad]);
    } else {
      owned.push(quad);
    }
    if (quad.predicate.value === RDF_TYPE && quad.object.value === rootType) {
      rootIris.add(subject);
    }
  }

  return [...rootIris].map((iri) => {
    const owned = bySubject.get(iri) ?? [];
    const referenced = owned
      .filter(
        (quad) =>
          quad.object.termType === 'NamedNode' ||
          quad.object.termType === 'BlankNode',
      )
      .flatMap((quad) => bySubject.get(quad.object.value) ?? []);
    return [...owned, ...referenced];
  });
}
