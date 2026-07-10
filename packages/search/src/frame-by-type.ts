import type { Quad } from '@rdfjs/types';
import jsonld from 'jsonld';
import { rdf } from '@tpluscode/rdf-ns-builders';

const RDF_TYPE = rdf.type.value;

/** A framed JSON-LD node (full-IRI keys); the engine-agnostic search IR. */
export type FramedNode = Record<string, unknown>;

const FRAME_OPTIONS = { omitGraph: false, embed: '@always' as const };

/**
 * A one-pass index of a quad source: every subject’s (deduplicated) triples,
 * plus the root subjects of each requested type in appearance order. Built by
 * {@link buildSubjectIndex} from a single iteration of the source, so a caller
 * can pass a chained generator (`function* () { yield* a; yield* b; }`) rather
 * than materialize a merged array; a multi-type projection then frames every
 * type off this one index instead of re-scanning per type.
 */
export interface SubjectIndex {
  /** Each subject IRI → its own deduplicated triples, in first-seen order. */
  readonly bySubject: ReadonlyMap<string, readonly Quad[]>;
  /** Each requested root type IRI → its root subjects, in appearance order. */
  readonly rootsByType: ReadonlyMap<string, readonly string[]>;
}

/**
 * Iterate `quads` once, grouping each subject’s triples and collecting the root
 * subjects of every type in `rootTypes`. Duplicate triples are collapsed here
 * because some SPARQL engines (e.g. QLever) do not deduplicate CONSTRUCT
 * output. The source is consumed a single time, so it may be a one-shot
 * iterable (a generator chaining several sources); the whole subject index is
 * held, but never more than that plus one framed subgraph at a time
 * downstream.
 */
export function buildSubjectIndex(
  quads: Iterable<Quad>,
  rootTypes: Iterable<string>,
): SubjectIndex {
  const bySubject = new Map<string, Quad[]>();
  const rootsByType = new Map<string, string[]>();
  for (const type of rootTypes) {
    rootsByType.set(type, []);
  }
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
    // `rootsByType` is keyed by exactly the requested root types, so the lookup
    // doubles as the membership test: a hit means this subject is a root.
    if (quad.predicate.value === RDF_TYPE) {
      const roots = rootsByType.get(quad.object.value);
      if (roots !== undefined) {
        roots.push(subject);
      }
    }
  }
  return { bySubject, rootsByType };
}

/**
 * Frame every root subject of `rootType` from a prebuilt {@link SubjectIndex}
 * into one JSON-LD node – the reusable core behind {@link frameByType}. Each
 * root subject’s own triples plus the one-hop nodes it references (e.g. nested
 * publisher/distribution resources) are framed one subject at a time, so beyond
 * the shared subject index only a single subgraph is held (whole-graph
 * `jsonld.frame()` is ~O(N²)). The frame carries no `@context`, so framed keys
 * are full predicate IRIs.
 */
export async function* frameSubjects(
  index: SubjectIndex,
  rootType: string,
): AsyncIterable<FramedNode> {
  const { bySubject } = index;
  // A type the index was not built for has no roots, so it frames nothing; the
  // `projectType`/`projectGraph` callers only pass types they registered.
  const roots = index.rootsByType.get(rootType) ?? [];
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
    // returns several root nodes and `[0]` could be the referenced one — which
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

/**
 * Frame CONSTRUCT quads into one JSON-LD node per subject of `rootType`, for a
 * single root type. Consumes `quads` once (see {@link buildSubjectIndex}), so
 * it accepts any `Iterable` – a materialized array or a chained generator. For
 * a multi-type schema, {@link buildSubjectIndex} + {@link frameSubjects} share
 * one index across types rather than re-scanning per type.
 */
export async function* frameByType(
  quads: Iterable<Quad>,
  rootType: string,
): AsyncIterable<FramedNode> {
  yield* frameSubjects(buildSubjectIndex(quads, [rootType]), rootType);
}
