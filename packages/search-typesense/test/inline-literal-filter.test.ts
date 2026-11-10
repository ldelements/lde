import { describe, expect, it } from 'vitest';
import { defineSearchType, searchSchema } from '@lde/search';
import { buildCollectionDefinition } from '../src/collection-definition.js';
import { buildSearchParams } from '../src/query-compiler.js';

const SCHEMA_ORG = 'https://schema.org/';

/** An entry made of literals alone: nothing in it names another document. */
const propertyValue = defineSearchType({
  name: 'PropertyValue',
  fields: [
    {
      name: 'value',
      kind: 'keyword',
      path: `${SCHEMA_ORG}value`,
      output: true,
      filterable: true,
    },
    {
      name: 'propertyID',
      kind: 'keyword',
      path: `${SCHEMA_ORG}propertyID`,
      output: true,
      filterable: true,
    },
    {
      name: 'name',
      kind: 'keyword',
      path: `${SCHEMA_ORG}name`,
      output: true,
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
      filterable: true,
      ref: { strategy: 'inline', typeName: 'PropertyValue' },
    },
  ],
});

const schema = searchSchema(work, propertyValue);

describe('an inline reference filtered on its own literal fields', () => {
  it('indexes the filterable leaves and no identity companion', () => {
    const fields = buildCollectionDefinition(work, { schema }).fields ?? [];
    const byName = new Map(fields.map((field) => [field.name, field]));

    expect(byName.get('identifier')).toMatchObject({
      type: 'object[]',
      index: true,
    });
    expect(byName.get('identifier.value')).toMatchObject({
      type: 'string[]',
      index: true,
    });
    expect(byName.get('identifier.propertyID')).toMatchObject({
      index: true,
    });
    expect(byName.get('identifier.name')).toMatchObject({ index: false });
    expect(byName.has('identifier_id')).toBe(false);
  });

  it('welds conditions on its leaves to one entry', () => {
    const params = buildSearchParams(
      {
        where: [
          {
            or: [
              {
                field: 'identifier',
                entry: [
                  { field: 'value', in: ['G11125-19'] },
                  { field: 'propertyID', in: ['https://example.org/object'] },
                ],
              },
            ],
          },
        ],
        orderBy: [],
        limit: 10,
        offset: 0,
        facets: [],
        locale: 'nl',
      },
      work,
      { schema },
    );

    expect(params.filter_by).toBe(
      'identifier.{value:=[`G11125-19`] && propertyID:=[`https://example.org/object`]}',
    );
  });

  it('compiles membership on it to nothing rather than the object', () => {
    // A hand-built query: `assertValidQuery` refuses this first.
    const params = buildSearchParams(
      {
        where: [{ or: [{ field: 'identifier', in: ['G11125-19'] }] }],
        orderBy: [],
        limit: 10,
        offset: 0,
        facets: [],
        locale: 'nl',
      },
      work,
      { schema },
    );

    expect(params.filter_by).toBe('id:=[]');
  });
});
