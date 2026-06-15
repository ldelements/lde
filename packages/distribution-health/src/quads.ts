import { DataFactory, type Quad } from 'n3';
import type { ValidityVerdict } from './verdict.js';

const { namedNode, literal, blankNode, quad } = DataFactory;

const RDF_TYPE = namedNode('http://www.w3.org/1999/02/22-rdf-syntax-ns#type');
const DQV_QUALITY_MEASUREMENT = namedNode(
  'http://www.w3.org/ns/dqv#QualityMeasurement',
);
const DQV_COMPUTED_ON = namedNode('http://www.w3.org/ns/dqv#computedOn');
const DQV_IS_MEASUREMENT_OF = namedNode(
  'http://www.w3.org/ns/dqv#isMeasurementOf',
);
const DQV_VALUE = namedNode('http://www.w3.org/ns/dqv#value');
const PROV_ACTIVITY = namedNode('http://www.w3.org/ns/prov#Activity');
const PROV_WAS_GENERATED_BY = namedNode(
  'http://www.w3.org/ns/prov#wasGeneratedBy',
);
const PROV_WAS_ASSOCIATED_WITH = namedNode(
  'http://www.w3.org/ns/prov#wasAssociatedWith',
);
const PROV_GENERATED_AT_TIME = namedNode(
  'http://www.w3.org/ns/prov#generatedAtTime',
);
const PROV_USED = namedNode('http://www.w3.org/ns/prov#used');
const PROV_QUALIFIED_USAGE = namedNode(
  'http://www.w3.org/ns/prov#qualifiedUsage',
);
const PROV_USAGE = namedNode('http://www.w3.org/ns/prov#Usage');
const PROV_ENTITY = namedNode('http://www.w3.org/ns/prov#entity');
const RDFS_COMMENT = namedNode('http://www.w3.org/2000/01/rdf-schema#comment');
const FAILURE_REASON = namedNode('https://w3id.org/lde/failure#reason');
const VALIDITY_FAILURE_SCHEME =
  'https://w3id.org/lde/distribution-validity-failure#';
const XSD_BOOLEAN = namedNode('http://www.w3.org/2001/XMLSchema#boolean');
const XSD_DATE_TIME = namedNode('http://www.w3.org/2001/XMLSchema#dateTime');

// These terms are generic to RDF-distribution health, not heritage-specific, so
// they are minted under the LDElements namespace (`https://w3id.org/lde/`) —
// the same family `@lde/pipeline` already uses for `sourceFingerprint`,
// `pipelineVersion` and `status`. Consumers such as NDE reuse these URIs rather
// than re-minting their own. `validatedFingerprint` sits beside the existing
// `sourceFingerprint` under `provenance#`.
const VALIDITY_METRIC = namedNode(
  'https://w3id.org/lde/metric#distribution-rdf-valid',
);
const VALIDATED_FINGERPRINT = namedNode(
  'https://w3id.org/lde/provenance#validatedFingerprint',
);

/** Provenance context stamped onto a verdict’s quads. */
export interface ValidityProvenance {
  /** The distribution’s access URL – the subject the verdict is about. */
  distributionUrl: string;
  /** When the verdict was produced. */
  generatedAt: Date;
  /** IRI of the software that produced the verdict (producer attribution). */
  producer: string;
}

/**
 * Map a validity verdict to DQV/PROV quads: a `dqv:QualityMeasurement` of the
 * `metric:distribution-rdf-valid` metric, computed on the distribution itself.
 */
export function* validityToQuads(
  verdict: ValidityVerdict,
  provenance: ValidityProvenance,
): Iterable<Quad> {
  const distribution = namedNode(provenance.distributionUrl);
  const measurement = blankNode();
  const activity = blankNode();

  yield quad(measurement, RDF_TYPE, DQV_QUALITY_MEASUREMENT);
  yield quad(measurement, DQV_COMPUTED_ON, distribution);
  yield quad(measurement, DQV_IS_MEASUREMENT_OF, VALIDITY_METRIC);
  yield quad(
    measurement,
    DQV_VALUE,
    literal(verdict.valid ? 'true' : 'false', XSD_BOOLEAN),
  );
  yield quad(
    measurement,
    PROV_GENERATED_AT_TIME,
    literal(provenance.generatedAt.toISOString(), XSD_DATE_TIME),
  );
  yield quad(measurement, PROV_WAS_GENERATED_BY, activity);
  if (verdict.validatedFingerprint !== null) {
    yield quad(
      measurement,
      VALIDATED_FINGERPRINT,
      literal(verdict.validatedFingerprint),
    );
  }

  yield quad(activity, RDF_TYPE, PROV_ACTIVITY);
  yield quad(
    activity,
    PROV_WAS_ASSOCIATED_WITH,
    namedNode(provenance.producer),
  );

  if (!verdict.valid && verdict.reason !== undefined) {
    yield* failureUsageQuads(activity, distribution, verdict);
  }
}

/**
 * The PROV qualified-usage shape recording why the distribution was judged
 * invalid: the activity `prov:used` the distribution and `prov:qualifiedUsage`
 * a `prov:Usage` carrying the typed `failure:reason` concept and, when the
 * parser provided one, a free-text `rdfs:comment`. Mirrors the failure shape in
 * `dataset-knowledge-graph`’s `failureUsage`.
 */
function* failureUsageQuads(
  activity: ReturnType<typeof blankNode>,
  distribution: ReturnType<typeof namedNode>,
  verdict: ValidityVerdict,
): Iterable<Quad> {
  const usage = blankNode();

  yield quad(activity, PROV_USED, distribution);
  yield quad(activity, PROV_QUALIFIED_USAGE, usage);

  yield quad(usage, RDF_TYPE, PROV_USAGE);
  yield quad(usage, PROV_ENTITY, distribution);
  yield quad(
    usage,
    FAILURE_REASON,
    namedNode(`${VALIDITY_FAILURE_SCHEME}${verdict.reason}`),
  );

  if (verdict.message !== undefined) {
    yield quad(usage, RDFS_COMMENT, literal(verdict.message));
  }
}
