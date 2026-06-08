import type { ExecutorContext, QuadTransform } from '@lde/pipeline';
import type { Quad } from '@rdfjs/types';
import { DataFactory } from 'n3';

const { namedNode, quad, literal, blankNode } = DataFactory;

const RDF = 'http://www.w3.org/1999/02/22-rdf-syntax-ns#';
const VOID = 'http://rdfs.org/ns/void#';
const XSD = 'http://www.w3.org/2001/XMLSchema#';

const rdfType = namedNode(`${RDF}type`);
const voidLinkset = namedNode(`${VOID}Linkset`);
const voidSubjectsTarget = namedNode(`${VOID}subjectsTarget`);
const voidObjectsTarget = namedNode(`${VOID}objectsTarget`);
const voidTriples = namedNode(`${VOID}triples`);
const xsdInteger = namedNode(`${XSD}integer`);

/**
 * Creates a {@link QuadTransform} that consumes `void:Linkset` quads from a
 * stage's executor output, matches each `void:objectsTarget` against the
 * configured URI space prefixes using `startsWith`, and aggregates triple
 * counts per matched space.
 *
 * Emitted `void:objectsTarget` values point to the target dataset IRI (taken
 * from the metadata quad subjects), not the raw URI space prefix. Unmatched
 * linksets are discarded.
 *
 * Attach it to the `object-uri-space.rq` stage's executor – directly via
 * {@link uriSpaces} or through the `transforms` map of {@link voidStages}.
 */
export function withUriSpaces(
  uriSpaces: ReadonlyMap<string, readonly Quad[]>,
): QuadTransform<ExecutorContext> {
  return (quads, { dataset }) =>
    aggregateUriSpaces(quads, dataset.iri.toString(), uriSpaces);
}

async function* aggregateUriSpaces(
  quads: AsyncIterable<Quad>,
  datasetIri: string,
  uriSpaces: ReadonlyMap<string, readonly Quad[]>,
): AsyncIterable<Quad> {
  // Group inner quads by subject (each subject = one Linkset).
  const linksets = new Map<string, Quad[]>();
  for await (const q of quads) {
    let group = linksets.get(q.subject.value);
    if (group === undefined) {
      group = [];
      linksets.set(q.subject.value, group);
    }
    group.push(q);
  }

  // Extract objectsTarget and triples count per Linkset,
  // match against configured URI spaces, and aggregate counts.
  const aggregated = new Map<
    string,
    { count: number; metadata: readonly Quad[] }
  >();
  for (const group of linksets.values()) {
    const objectsTarget = group.find((q) =>
      q.predicate.equals(voidObjectsTarget),
    )?.object.value;
    const triplesValue = group.find((q) => q.predicate.equals(voidTriples))
      ?.object.value;

    if (objectsTarget === undefined || triplesValue === undefined) continue;

    const count = parseInt(triplesValue, 10);
    for (const [uriSpace, metadata] of uriSpaces) {
      if (objectsTarget.startsWith(uriSpace)) {
        const existing = aggregated.get(uriSpace);
        aggregated.set(uriSpace, {
          count: (existing?.count ?? 0) + count,
          metadata,
        });
        break;
      }
    }
  }

  // Emit aggregated Linkset quads.
  const datasetNode = namedNode(datasetIri);
  for (const [, { count, metadata }] of aggregated) {
    const linksetNode = blankNode();
    const targetDatasetNode = metadata[0].subject;

    yield quad(linksetNode, rdfType, voidLinkset);
    yield quad(linksetNode, voidSubjectsTarget, datasetNode);
    yield quad(linksetNode, voidObjectsTarget, targetDatasetNode);
    yield quad(linksetNode, voidTriples, literal(count.toString(), xsdInteger));

    for (const metadataQuad of metadata) {
      yield metadataQuad;
    }
  }
}
