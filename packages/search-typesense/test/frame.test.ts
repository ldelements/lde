import { describe, expect, it } from 'vitest';
import { DataFactory } from 'n3';
import type { Quad } from '@rdfjs/types';
import { frame, type FrameField } from '../src/frame.js';

const { quad, namedNode, literal } = DataFactory;

const SUBJECT = 'https://example.org/dataset/1';

function triples(...pairs: ReadonlyArray<[string, string]>): Quad[] {
  return pairs.map(([predicate, object]) =>
    quad(namedNode(SUBJECT), namedNode(predicate), literal(object)),
  );
}

const fields: readonly FrameField[] = [
  {
    field: 'title',
    predicate: 'http://purl.org/dc/terms/title',
    type: 'string',
  },
  {
    field: 'keyword',
    predicate: 'http://www.w3.org/ns/dcat#keyword',
    type: 'string[]',
  },
  { field: 'size', predicate: 'http://rdfs.org/ns/void#triples', type: 'int' },
  {
    field: 'conformant',
    predicate: 'https://def.nde.nl/metric#conformant',
    type: 'bool',
  },
  {
    field: 'date_posted',
    predicate: 'https://schema.org/datePosted',
    type: 'unixtime',
  },
];

describe('frame', () => {
  it('always sets the subject IRI as id', () => {
    expect(frame([], SUBJECT, fields)).toEqual({ id: SUBJECT });
  });

  it('takes the first value for single-valued fields', () => {
    const document = frame(
      triples(['http://purl.org/dc/terms/title', 'Verhaal van Utrecht']),
      SUBJECT,
      fields,
    );
    expect(document.title).toBe('Verhaal van Utrecht');
  });

  it('collects all values for array fields', () => {
    const document = frame(
      triples(
        ['http://www.w3.org/ns/dcat#keyword', 'utrecht'],
        ['http://www.w3.org/ns/dcat#keyword', 'verhaal'],
      ),
      SUBJECT,
      fields,
    );
    expect(document.keyword).toEqual(['utrecht', 'verhaal']);
  });

  it('coerces int, bool and unixtime', () => {
    const document = frame(
      triples(
        ['http://rdfs.org/ns/void#triples', '4200'],
        ['https://def.nde.nl/metric#conformant', 'true'],
        ['https://schema.org/datePosted', '2024-01-02T00:00:00.000Z'],
      ),
      SUBJECT,
      fields,
    );
    expect(document.size).toBe(4200);
    expect(document.conformant).toBe(true);
    expect(document.date_posted).toBe(
      Math.trunc(Date.parse('2024-01-02T00:00:00.000Z') / 1000),
    );
  });

  it('omits numeric and date fields whose value does not parse', () => {
    const document = frame(
      triples(
        ['http://rdfs.org/ns/void#triples', 'not-a-number'],
        ['https://schema.org/datePosted', 'not-a-date'],
      ),
      SUBJECT,
      fields,
    );
    expect(document).toEqual({ id: SUBJECT });
  });

  it('omits fields whose predicate has no quad', () => {
    const document = frame(
      triples(['http://purl.org/dc/terms/title', 'Only a title']),
      SUBJECT,
      fields,
    );
    expect(document).toEqual({ id: SUBJECT, title: 'Only a title' });
  });

  it('ignores quads for other subjects', () => {
    const foreign = quad(
      namedNode('https://example.org/dataset/2'),
      namedNode('http://purl.org/dc/terms/title'),
      literal('Other'),
    );
    const document = frame([foreign], SUBJECT, fields);
    expect(document).toEqual({ id: SUBJECT });
  });
});
