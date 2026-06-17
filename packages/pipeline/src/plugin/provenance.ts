import type { QuadTransform } from '../stage.js';
import type { BeforeStageWriteContext, PipelinePlugin } from '../pipeline.js';
import { hashSuffix, skolemIri } from '@lde/dataset';
import type { Quad } from '@rdfjs/types';
import { DataFactory } from 'n3';
import { prov, rdf, xsd } from '@tpluscode/rdf-ns-builders';

const { namedNode, literal, quad } = DataFactory;

/** QuadTransform that appends PROV-O provenance quads. */
export const provenanceTransform: QuadTransform<BeforeStageWriteContext> = (
  quads,
  { dataset, stage },
) => appendProvenanceQuads(quads, dataset.iri.toString(), stage, new Date());

/** Pipeline plugin that appends PROV-O provenance to every stage's output. */
export function provenancePlugin(): PipelinePlugin {
  return {
    name: 'provenance',
    beforeStageWrite: provenanceTransform,
  };
}

async function* appendProvenanceQuads(
  quads: AsyncIterable<Quad>,
  iri: string,
  stage: string,
  startedAt: Date,
): AsyncIterable<Quad> {
  for await (const q of quads) {
    yield q;
  }

  const endedAt = new Date();
  const subject = namedNode(iri);
  // Skolemise the activity to a stable IRI keyed on (dataset, stage) instead of
  // a blank node. Per-dataset outputs are merged into one graph (the DKG index
  // cats every dataset's file together), where blank-node labels are not unique
  // across documents and would fuse unrelated activities into one node — one
  // prov:Activity wrongly wasGeneratedBy several datasets (see issue #474).
  // The IRI also makes a re-run idempotent: same (dataset, stage) → same node.
  // The `.well-known/prov#activity-<hash>` shape mirrors the linkset skolem.
  const activity = namedNode(
    skolemIri(`${iri}/.well-known/prov#activity`, hashSuffix(stage)),
  );

  yield quad(subject, rdf.type, prov.Entity);
  yield quad(subject, prov.wasGeneratedBy, activity);
  yield quad(activity, rdf.type, prov.Activity);
  yield quad(
    activity,
    prov.startedAtTime,
    literal(startedAt.toISOString(), xsd.dateTime),
  );
  yield quad(
    activity,
    prov.endedAtTime,
    literal(endedAt.toISOString(), xsd.dateTime),
  );
}
