import { describe, expect, it } from 'vitest';
import { projectDocument } from '../src/project.js';
import { defineSearchType, searchSchema } from '../src/schema.js';

const SCHEMA_ORG = 'https://schema.org/';
const PRIREF = 'https://data.axiell.com/vocabulary#Priref';

// The extraction CONSTRUCT emits each value under its field’s IR Alias, so a
// framed node is keyed by (declaring type, field) – never by the source path.
const alias = (type: string, field: string) => `urn:lde:${type}/${field}`;
const valueKey = (field: string) => alias('PropertyValue', field);

/** A value the graph may state bare or on a node, as SCHEMA-AP-NDE allows. */
const propertyValue = defineSearchType({
  name: 'PropertyValue',
  literalField: 'value',
  fields: [
    {
      name: 'value',
      kind: 'keyword',
      path: `${SCHEMA_ORG}value`,
      output: true,
    },
    {
      name: 'propertyID',
      kind: 'reference',
      path: `${SCHEMA_ORG}propertyID`,
      output: true,
      ref: { strategy: 'idOnly' },
    },
  ],
});

const work = defineSearchType({
  name: 'Work',
  class: `${SCHEMA_ORG}CreativeWork`,
  fields: [
    {
      name: 'identifier',
      kind: 'reference',
      path: `${SCHEMA_ORG}identifier`,
      array: true,
      output: true,
      ref: { strategy: 'inline', typeName: 'PropertyValue' },
    },
  ],
});

describe('a node the graph may state as a bare literal', () => {
  const schema = searchSchema(work, propertyValue);

  it('reads a literal into the literal field, beside the nodes, as one list', () => {
    const document = projectDocument(
      {
        '@id': 'https://ex/work/1',
        [alias('Work', 'identifier')]: [
          { '@value': 'G11125-19' },
          {
            [valueKey('value')]: [{ '@value': '12042' }],
            [valueKey('propertyID')]: [{ '@id': PRIREF }],
          },
          // A bare string is a literal too, as everywhere a literal is read.
          'A-1',
        ],
      },
      work,
      schema,
    );

    expect(document.identifier).toEqual([
      { value: 'G11125-19' },
      { value: '12042', propertyID: PRIREF },
      { value: 'A-1' },
    ]);
  });

  it('still projects nothing for a literal where the type declares no literal field', () => {
    const plain = defineSearchType({
      name: 'PropertyValue',
      fields: propertyValue.fields,
    });
    const document = projectDocument(
      {
        '@id': 'https://ex/work/2',
        [alias('Work', 'identifier')]: [{ '@value': 'G11125-19' }],
      },
      work,
      searchSchema(work, plain),
    );

    expect(document).not.toHaveProperty('identifier');
  });

  it('fills a literal field with no path from a literal only, language tag kept', () => {
    // `schema:size` stated bare is display text no QuantitativeValue node
    // carries, so the field has nothing to read off a node.
    const size = defineSearchType({
      name: 'Size',
      literalField: 'statement',
      fields: [
        { name: 'statement', kind: 'text', locales: ['nl'], output: true },
        {
          name: 'value',
          kind: 'number',
          path: `${SCHEMA_ORG}value`,
          output: true,
        },
      ],
    });
    const sized = defineSearchType({
      name: 'Sized',
      class: `${SCHEMA_ORG}Sculpture`,
      fields: [
        {
          name: 'size',
          kind: 'reference',
          path: `${SCHEMA_ORG}size`,
          array: true,
          output: true,
          ref: { strategy: 'inline', typeName: 'Size' },
        },
      ],
    });
    const document = projectDocument(
      {
        '@id': 'https://ex/work/3',
        [alias('Sized', 'size')]: [
          { '@value': '74 cm hoog bij 92 cm breed', '@language': 'nl' },
          { [alias('Size', 'value')]: [{ '@value': 74 }] },
        ],
      },
      sized,
      searchSchema(sized, size),
    );

    expect(document.size).toEqual([
      { statement_nl: '74 cm hoog bij 92 cm breed' },
      { value: 74 },
    ]);
  });

  it('refuses a required literal field with no path, which a node never fills', () => {
    const strict = defineSearchType({
      name: 'PropertyValue',
      literalField: 'statement',
      fields: [
        {
          name: 'statement',
          kind: 'text',
          locales: ['nl'],
          output: true,
          required: true,
        },
      ],
    });

    expect(() => searchSchema(work, strict)).toThrow(
      /requires literal field “statement”, which has no “path”/,
    );
  });

  it('reads a literal as an entry ahead of reading it as an endpoint', () => {
    // With an edge class too, the edge reader would wrap a literal value
    // object as an endpoint; the literal reader runs first and keeps it.
    const ROLE = `${SCHEMA_ORG}Role`;
    const person = defineSearchType({
      name: 'Person',
      class: `${SCHEMA_ORG}Person`,
      labelField: 'name',
      fields: [
        {
          name: 'name',
          kind: 'text',
          path: `${SCHEMA_ORG}name`,
          locales: ['und'],
          output: true,
          searchable: { weight: 1 },
        },
      ],
    });
    const role = defineSearchType({
      name: 'CreditRole',
      edgeClass: ROLE,
      literalField: 'credit',
      fields: [
        {
          name: 'credit',
          kind: 'keyword',
          path: `${SCHEMA_ORG}roleName`,
          output: true,
        },
        {
          name: 'agent',
          kind: 'reference',
          path: `${SCHEMA_ORG}contributor`,
          output: true,
          ref: { strategy: 'lookup', target: 'Person' },
        },
      ],
    });
    const credited = defineSearchType({
      name: 'Credited',
      class: `${SCHEMA_ORG}Photograph`,
      fields: [
        {
          name: 'contributor',
          kind: 'reference',
          path: `${SCHEMA_ORG}contributor`,
          array: true,
          output: true,
          filterable: true,
          ref: {
            strategy: 'inline',
            typeName: 'CreditRole',
            identity: 'agent',
          },
        },
      ],
    });
    const document = projectDocument(
      {
        '@id': 'https://ex/work/4',
        [alias('Credited', 'contributor')]: [
          { '@value': 'Studio Smeets' },
          { '@id': 'https://ex/person/1', '@type': `${SCHEMA_ORG}Person` },
        ],
      },
      credited,
      searchSchema(credited, person, role),
    );

    expect(document.contributor).toEqual([
      { credit: 'Studio Smeets' },
      { agent: 'https://ex/person/1' },
    ]);
  });

  it('refuses a literal field the type does not declare', () => {
    const unknown = defineSearchType({
      ...propertyValue,
      literalField: 'name',
    });

    expect(() => searchSchema(work, unknown)).toThrow(
      /names literal field “name”, which it does not declare/,
    );
  });

  it('refuses a literal field that reads no literal', () => {
    const reference = defineSearchType({
      ...propertyValue,
      literalField: 'propertyID',
    });
    const derived = defineSearchType({
      ...propertyValue,
      fields: [
        {
          name: 'value',
          kind: 'keyword',
          output: true,
          derive: () => 'constant',
        },
      ],
    });

    const projected = defineSearchType({
      ...propertyValue,
      fields: [
        { name: 'value', kind: 'keyword', output: true, from: 'dataset' },
      ],
    });

    expect(() => searchSchema(work, projected)).toThrow(
      /literal field “value”, which reads no literal/,
    );
    expect(() => searchSchema(work, reference)).toThrow(
      /literal field “propertyID”, which reads no literal/,
    );
    expect(() => searchSchema(work, derived)).toThrow(
      /literal field “value”, which reads no literal/,
    );
  });

  it('refuses another required field, which a literal never carries', () => {
    const strict = defineSearchType({
      ...propertyValue,
      fields: [
        propertyValue.fields[0],
        { ...propertyValue.fields[1], required: true },
      ],
    });

    expect(() => searchSchema(work, strict)).toThrow(
      /declares a “literalField” and requires “propertyID”/,
    );
  });
});
