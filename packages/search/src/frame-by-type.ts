import type { Quad } from '@rdfjs/types';
import jsonld from 'jsonld';

/** A framed JSON-LD node (full-IRI keys); the engine-agnostic search IR. */
export type FramedNode = Record<string, unknown>;

const FRAME_OPTIONS = { omitGraph: false, embed: '@always' as const };

/**
 * A one-pass index of a quad source: every subject’s (deduplicated) triples.
 * Built by {@link buildSubjectIndex} from a single iteration of the source, so a
 * caller can pass a chained generator (`function* () { yield* a; yield* b; }`)
 * rather than materialize a merged array, then frame any of its subjects off
 * this one index.
 */
export interface SubjectIndex {
  /** Each subject IRI → its own deduplicated triples, in first-seen order. */
  readonly bySubject: ReadonlyMap<string, readonly Quad[]>;
}

/**
 * Iterate `quads` once, grouping each subject’s triples. Duplicate triples are
 * collapsed here because some SPARQL engines (e.g. QLever) do not deduplicate
 * CONSTRUCT output. The source is consumed a single time, so it may be a
 * one-shot iterable (a generator chaining several sources); the whole subject
 * index is held, but never more than that plus one framed subgraph at a time
 * downstream.
 *
 * Roots are never discovered here – the caller ({@link projectRoots}, from the
 * pipeline selector) already holds them and passes them to {@link frameSubjects}
 * – so `quads` need carry no `rdf:type` triple.
 */
export function buildSubjectIndex(quads: Iterable<Quad>): SubjectIndex {
  const bySubject = new Map<string, Quad[]>();
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
  }
  return { bySubject };
}

/**
 * Frame each of the given `roots` from a prebuilt {@link SubjectIndex} into one
 * JSON-LD node. Each root subject’s own triples plus the one-hop nodes it
 * references (e.g. nested publisher/distribution resources) are framed one
 * subject at a time, so beyond the shared subject index only a single subgraph
 * is held (whole-graph `jsonld.frame()` is ~O(N²)). The frame carries no
 * `@context`, so framed keys are full predicate IRIs.
 *
 * The roots are supplied explicitly rather than discovered from `rdf:type`: the
 * caller ({@link projectRoots}, from the pipeline selector) already holds them
 * and passes them directly. A root absent from the index simply frames nothing.
 */
export async function* frameSubjects(
  index: SubjectIndex,
  roots: readonly string[],
): AsyncIterable<FramedNode> {
  const { bySubject } = index;
  for (const rootIri of roots) {
    const owned = bySubject.get(rootIri) ?? [];
    const referenced = owned
      .filter(
        (quad) =>
          quad.object.termType === 'NamedNode' ||
          quad.object.termType === 'BlankNode',
      )
      .flatMap((quad) => bySubject.get(quad.object.value) ?? []);
    const subgraph = [...owned, ...referenced];
    const expanded = await jsonld.fromRDF(subgraph);
    // Frame for THIS specific root subject by `@id`, not just by root type. A
    // one-hop reference can itself be of `rootType` (e.g. a terminology source
    // that is also a separately registered dataset), so framing by type alone
    // returns several root nodes and `[0]` could be the referenced one – which
    // would emit it twice and drop this subject entirely.
    const framed = await jsonld.frame(
      expanded,
      { '@id': rootIri },
      FRAME_OPTIONS,
    );
    const node = (framed['@graph'] as FramedNode[] | undefined)?.[0];
    if (node !== undefined) {
      yield node;
    }
  }
}
