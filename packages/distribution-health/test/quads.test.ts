import { describe, it, expect } from 'vitest';
import { Store } from 'n3';
import {
  validityToQuads,
  type ValidityProvenance,
  type ValidityVerdict,
} from '../src/index.js';

const DQV = 'http://www.w3.org/ns/dqv#';
const METRIC = 'https://w3id.org/lde/metric#';
const LDE_PROVENANCE = 'https://w3id.org/lde/provenance#';
const XSD = 'http://www.w3.org/2001/XMLSchema#';
const PROV = 'http://www.w3.org/ns/prov#';
const RDF_TYPE = 'http://www.w3.org/1999/02/22-rdf-syntax-ns#type';
const RDFS = 'http://www.w3.org/2000/01/rdf-schema#';
const FAILURE_REASON = 'https://w3id.org/lde/failure#reason';
const VALIDITY_FAILURE = 'https://w3id.org/lde/distribution-validity-failure#';

const DISTRIBUTION = 'http://example.org/data.rdf';

const provenance: ValidityProvenance = {
  distributionUrl: DISTRIBUTION,
  generatedAt: new Date('2026-06-15T10:00:00.000Z'),
  producer: 'https://www.npmjs.com/package/@lde/pipeline',
};

function store(verdict: ValidityVerdict): Store {
  const result = new Store();
  for (const quad of validityToQuads(verdict, provenance)) {
    result.addQuad(quad);
  }
  return result;
}

const validVerdict: ValidityVerdict = {
  valid: true,
  validatedFingerprint: 'fp-1',
  depth: 'deep',
};

describe('validityToQuads', () => {
  it('emits a DQV quality measurement of the validity metric, computed on the distribution', () => {
    const result = store(validVerdict);

    const measurements = result.getQuads(
      null,
      `${DQV}isMeasurementOf`,
      `${METRIC}distribution-rdf-valid`,
      null,
    );
    expect(measurements).toHaveLength(1);
    const measurement = measurements[0].subject;

    expect(
      result.getQuads(measurement, `${DQV}computedOn`, DISTRIBUTION, null),
    ).toHaveLength(1);

    const values = result.getQuads(measurement, `${DQV}value`, null, null);
    expect(values).toHaveLength(1);
    expect(values[0].object.value).toBe('true');
    expect(
      'datatype' in values[0].object && values[0].object.datatype.value,
    ).toBe(`${XSD}boolean`);

    expect(
      result.getQuads(measurement, RDF_TYPE, `${DQV}QualityMeasurement`, null),
    ).toHaveLength(1);
  });

  it('attributes the measurement to a PROV activity associated with the producer', () => {
    const result = store(validVerdict);

    const measurement = result.getQuads(
      null,
      `${DQV}isMeasurementOf`,
      `${METRIC}distribution-rdf-valid`,
      null,
    )[0].subject;

    const generatedBy = result.getQuads(
      measurement,
      `${PROV}wasGeneratedBy`,
      null,
      null,
    );
    expect(generatedBy).toHaveLength(1);
    const activity = generatedBy[0].object;

    expect(
      result.getQuads(activity, RDF_TYPE, `${PROV}Activity`, null),
    ).toHaveLength(1);
    expect(
      result.getQuads(
        activity,
        `${PROV}wasAssociatedWith`,
        provenance.producer,
        null,
      ),
    ).toHaveLength(1);

    const generatedAt = result.getQuads(
      measurement,
      `${PROV}generatedAtTime`,
      null,
      null,
    );
    expect(generatedAt).toHaveLength(1);
    expect(generatedAt[0].object.value).toBe('2026-06-15T10:00:00.000Z');
    expect(
      'datatype' in generatedAt[0].object &&
        generatedAt[0].object.datatype.value,
    ).toBe(`${XSD}dateTime`);
  });

  it('records the validatedFingerprint the verdict was judged against', () => {
    const result = store(validVerdict);

    const measurement = result.getQuads(
      null,
      `${DQV}isMeasurementOf`,
      `${METRIC}distribution-rdf-valid`,
      null,
    )[0].subject;

    const fingerprints = result.getQuads(
      measurement,
      `${LDE_PROVENANCE}validatedFingerprint`,
      null,
      null,
    );
    expect(fingerprints).toHaveLength(1);
    expect(fingerprints[0].object.value).toBe('fp-1');
  });

  it('omits the validatedFingerprint when the verdict has none', () => {
    const result = store({ ...validVerdict, validatedFingerprint: null });

    expect(
      result.getQuads(
        null,
        `${LDE_PROVENANCE}validatedFingerprint`,
        null,
        null,
      ),
    ).toHaveLength(0);
  });

  it('records the typed failure reason and parser message for an invalid verdict', () => {
    const result = store({
      valid: false,
      reason: 'parse-error',
      message: 'QName not allowed for property: rdf:Description',
      validatedFingerprint: 'fp-1',
      depth: 'deep',
    });

    // value is false
    const measurement = result.getQuads(
      null,
      `${DQV}isMeasurementOf`,
      `${METRIC}distribution-rdf-valid`,
      null,
    )[0].subject;
    expect(
      result.getQuads(measurement, `${DQV}value`, null, null)[0].object.value,
    ).toBe('false');

    // activity → qualified usage on the distribution, carrying the reason
    const activity = result.getQuads(
      measurement,
      `${PROV}wasGeneratedBy`,
      null,
      null,
    )[0].object;
    const usages = result.getQuads(
      activity,
      `${PROV}qualifiedUsage`,
      null,
      null,
    );
    expect(usages).toHaveLength(1);
    const usage = usages[0].object;

    expect(result.getQuads(usage, RDF_TYPE, `${PROV}Usage`, null)).toHaveLength(
      1,
    );
    expect(
      result.getQuads(usage, `${PROV}entity`, DISTRIBUTION, null),
    ).toHaveLength(1);
    expect(
      result.getQuads(
        usage,
        FAILURE_REASON,
        `${VALIDITY_FAILURE}parse-error`,
        null,
      ),
    ).toHaveLength(1);

    const comments = result.getQuads(usage, `${RDFS}comment`, null, null);
    expect(comments).toHaveLength(1);
    expect(comments[0].object.value).toBe(
      'QName not allowed for property: rdf:Description',
    );
  });

  it('records the empty failure reason with no message', () => {
    const result = store({
      valid: false,
      reason: 'empty',
      validatedFingerprint: 'fp-1',
      depth: 'deep',
    });

    expect(
      result.getQuads(null, FAILURE_REASON, `${VALIDITY_FAILURE}empty`, null),
    ).toHaveLength(1);
    expect(result.getQuads(null, `${RDFS}comment`, null, null)).toHaveLength(0);
  });

  it('emits no failure usage for a valid verdict', () => {
    const result = store(validVerdict);

    expect(result.getQuads(null, FAILURE_REASON, null, null)).toHaveLength(0);
    expect(
      result.getQuads(null, `${PROV}qualifiedUsage`, null, null),
    ).toHaveLength(0);
  });
});
