import type { QuadTransform } from '../stage.js';
import type { BeforeStageWriteContext, PipelinePlugin } from '../pipeline.js';
import { hashSuffix, skolemIri } from '@lde/dataset';
import type { Quad } from '@rdfjs/types';
import { DataFactory } from 'n3';

const { namedNode, literal, quad } = DataFactory;

const RDF_TYPE = namedNode('http://www.w3.org/1999/02/22-rdf-syntax-ns#type');
const PROV_ENTITY = namedNode('http://www.w3.org/ns/prov#Entity');
const PROV_ACTIVITY = namedNode('http://www.w3.org/ns/prov#Activity');
const PROV_WAS_GENERATED_BY = namedNode(
  'http://www.w3.org/ns/prov#wasGeneratedBy',
);
const PROV_STARTED_AT_TIME = namedNode(
  'http://www.w3.org/ns/prov#startedAtTime',
);
const PROV_ENDED_AT_TIME = namedNode('http://www.w3.org/ns/prov#endedAtTime');
const XSD_DATE_TIME = namedNode('http://www.w3.org/2001/XMLSchema#dateTime');

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

  yield quad(subject, RDF_TYPE, PROV_ENTITY);
  yield quad(subject, PROV_WAS_GENERATED_BY, activity);
  yield quad(activity, RDF_TYPE, PROV_ACTIVITY);
  yield quad(
    activity,
    PROV_STARTED_AT_TIME,
    literal(startedAt.toISOString(), XSD_DATE_TIME),
  );
  yield quad(
    activity,
    PROV_ENDED_AT_TIME,
    literal(endedAt.toISOString(), XSD_DATE_TIME),
  );
}
