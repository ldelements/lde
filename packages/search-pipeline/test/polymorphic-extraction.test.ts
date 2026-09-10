import { describe, expect, it } from 'vitest';
import { defineSearchType, searchSchema } from '@lde/search';
import { irAlias } from '@lde/search/adapter';
import { extractionQueryString } from '../src/extraction.js';

const SCHEMA = 'https://schema.org/';
const RDF_TYPE = 'http://www.w3.org/1999/02/22-rdf-syntax-ns#type';

/** Keyed on an authority IRI: what makes the hop load-bearing. */
const person = defineSearchType({
  name: 'Person',
  class: `${SCHEMA}Person`,
  labelField: 'name',
  key: { field: 'sameAs' },
  fields: [
    {
      name: 'name',
      kind: 'text',
      path: `<${SCHEMA}name>`,
      locales: ['nl'],
      output: true,
      searchable: { weight: 1 },
    },
    {
      name: 'sameAs',
      kind: 'reference',
      path: `<${SCHEMA}sameAs>`,
      array: true,
    },
  ],
});

const organization = defineSearchType({
  name: 'Organization',
  class: `${SCHEMA}Organization`,
  labelField: 'name',
  fields: [
    {
      name: 'name',
      kind: 'text',
      path: `<${SCHEMA}name>`,
      locales: ['nl'],
      output: true,
      searchable: { weight: 1 },
    },
    {
      name: 'location',
      kind: 'keyword',
      path: `<${SCHEMA}location>`,
      output: true,
    },
  ],
});

describe('extracting a lookup that names several targets', () => {
  it('reads the referent’s rdf:type, so the projection can tell which target it is', () => {
    const work = defineSearchType({
      name: 'Work',
      class: `${SCHEMA}CreativeWork`,
      fields: [
        {
          name: 'creator',
          kind: 'reference',
          path: `<${SCHEMA}creator>`,
          array: true,
          output: true,
          ref: { strategy: 'lookup', target: ['Person', 'Organization'] },
        },
      ],
    });
    const query = extractionQueryString(
      work,
      searchSchema(work, person, organization),
    );

    // Emitted as `rdf:type` itself, which framing carries as `@type`, and
    // bound OPTIONAL so an untyped referent keeps its row.
    expect(query).toContain(`<${RDF_TYPE}>`);
    expect(query).toContain('OPTIONAL');
    // Every keyed target contributes its key hop, under its own alias – a
    // plain lookup expands nothing else.
    expect(query).toContain(irAlias(person, person.fields[1]));
    expect(query).not.toContain(irAlias(organization, organization.fields[1]));
  });

  it('expands a local lookup through every target, in one OPTIONAL union', () => {
    const edge = defineSearchType({
      name: 'CreatorEdge',
      fields: [
        {
          name: 'creator',
          kind: 'reference',
          path: `<${SCHEMA}creator>`,
          output: true,
          ref: {
            strategy: 'lookup',
            target: ['Person', 'Organization'],
            local: true,
          },
        },
      ],
    });
    const work = defineSearchType({
      name: 'Work',
      class: `${SCHEMA}CreativeWork`,
      fields: [
        {
          name: 'creator',
          kind: 'reference',
          path: `<${SCHEMA}creator>`,
          array: true,
          output: true,
          ref: { strategy: 'inline', typeName: 'CreatorEdge' },
        },
      ],
    });
    const query = extractionQueryString(
      work,
      searchSchema(work, edge, person, organization),
    );

    expect(query).toContain(`<${RDF_TYPE}>`);
    // Each target's fields under that target's own aliases: the projection
    // reads a referent through whichever declaration its type matches.
    for (const field of person.fields) {
      expect(query).toContain(irAlias(person, field));
    }
    for (const field of organization.fields) {
      expect(query).toContain(irAlias(organization, field));
    }
  });

  it('reads no rdf:type for a lookup naming one target', () => {
    const work = defineSearchType({
      name: 'Work',
      class: `${SCHEMA}CreativeWork`,
      fields: [
        {
          name: 'creator',
          kind: 'reference',
          path: `<${SCHEMA}creator>`,
          output: true,
          ref: { strategy: 'lookup', target: 'Person' },
        },
      ],
    });
    expect(
      extractionQueryString(work, searchSchema(work, person)),
    ).not.toContain(RDF_TYPE);
  });
});
