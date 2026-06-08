import type { QuadTransform } from '../stage.js';
import type { PipelinePlugin } from '../pipeline.js';
import type { Dataset } from '@lde/dataset';
import type { Quad } from '@rdfjs/types';
import { DataFactory } from 'n3';

const { namedNode, literal, blankNode, quad } = DataFactory;

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
export const provenanceTransform: QuadTransform<{ dataset: Dataset }> = (
  quads,
  { dataset },
) => appendProvenanceQuads(quads, dataset.iri.toString(), new Date());

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
  startedAt: Date,
): AsyncIterable<Quad> {
  for await (const q of quads) {
    yield q;
  }

  const endedAt = new Date();
  const subject = namedNode(iri);
  const activity = blankNode();

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
