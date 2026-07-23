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
 * JSON-LD node. Each root subject’s own triples plus the nodes it references –
 * to `depth` hops (e.g. nested publisher/distribution resources at one hop, an
 * inline reference’s referents deeper) – are framed one subject at a time, so
 * beyond the shared subject index only a single subgraph is held (whole-graph
 * `jsonld.frame()` is ~O(N²)). The frame carries no `@context`, so framed keys
 * are full predicate IRIs.
 *
 * `depth` is the number of reference hops to embed; it defaults to one (the
 * long-standing single-hop embed) and comes from the schema for a type with
 * inline references (`inlineFramingDepth`). Bounded per batch, so the O(N²)
 * framing cost applies to a batch of roots, not the graph (ADR 12).
 *
 * The roots are supplied explicitly rather than discovered from `rdf:type`: the
 * caller ({@link projectRoots}, from the pipeline selector) already holds them
 * and passes them directly. A root absent from the index simply frames nothing –
 * without ever reaching `jsonld.frame`, whose `@id` validation would otherwise
 * throw on a root that is not an IRI (a blank-node label). A **blank-node root
 * is skipped** even when its label is in the index: a blank node has no stable
 * document key, so it can never become a search document – blank-node subjects
 * are embeddable through a reference, never indexable as roots.
 */
export async function* frameSubjects(
  index: SubjectIndex,
  roots: readonly string[],
  depth = 1,
): AsyncIterable<FramedNode> {
  const { bySubject } = index;
  for (const rootIri of roots) {
    const owned = bySubject.get(rootIri);
    if (owned === undefined || owned[0].subject.termType === 'BlankNode') {
      continue;
    }
    const subgraph = collectSubgraph(bySubject, rootIri, depth);
    const expanded = await jsonld.fromRDF(subgraph);
    // Frame for THIS specific root subject by its `@id`. The subgraph embeds the
    // root’s one-hop references, and such a referent can itself be one of the
    // requested `roots` (e.g. a terminology source that is also a separately
    // registered dataset). Framing by `{ '@id': rootIri }` pins the output to
    // this subject, so the referent is framed once in its own turn rather than
    // surfacing here as a second `@graph` node that `[0]` might pick instead.
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

/**
 * Collect a root subject’s triples plus those of every subject it references
 * within `depth` hops, breadth-first. Each subject is visited once (so a
 * reference cycle in the data terminates and no subject’s triples are
 * duplicated); `jsonld.frame` embeds whatever the subgraph reaches. Bounded by
 * `depth`, so only the reachable subgraph of one root is materialized at a time.
 */
function collectSubgraph(
  bySubject: ReadonlyMap<string, readonly Quad[]>,
  rootIri: string,
  depth: number,
): Quad[] {
  const collected: Quad[] = [];
  const visited = new Set<string>();
  let frontier = [rootIri];
  for (let hop = 0; hop <= depth; hop++) {
    const next: string[] = [];
    for (const subject of frontier) {
      if (visited.has(subject)) {
        continue;
      }
      visited.add(subject);
      const owned = bySubject.get(subject) ?? [];
      collected.push(...owned);
      if (hop < depth) {
        for (const quad of owned) {
          if (
            quad.object.termType === 'NamedNode' ||
            quad.object.termType === 'BlankNode'
          ) {
            next.push(quad.object.value);
          }
        }
      }
    }
    frontier = next;
  }
  return collected;
}
