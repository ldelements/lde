import { describe, expect, it } from 'vitest';
import { projectDocument, type SearchDocument } from '../src/project.js';
import {
  defineSearchType,
  inheritedFacetPolicies,
  inlineFramingDepth,
  labelTargetNamesOf,
  localLookupTargetsOf,
  physicalFields,
  referencedTargetsOf,
  searchSchema,
  storedTargetOf,
  TARGET_FIELD,
  validateSearchType,
} from '../src/schema.js';
import { validateQuery } from '../src/query.js';

const SCHEMA_ORG = 'https://schema.org/';
const alias = (type: string, field: string) => `urn:lde:${type}/${field}`;

/**
 * SCHEMA-AP-NDE ranges `creator` over Person OR Organization. The two differ
 * in the one declaration that changes what a reference stores: Person is keyed
 * on an authority IRI, Organization on nothing – and Person admits only its
 * authority-keyed ids to a facet.
 */
const person = defineSearchType({
  name: 'Person',
  class: `${SCHEMA_ORG}Person`,
  labelField: 'name',
  key: { field: 'sameAs' },
  facetKeys: { only: (id) => id.startsWith('https://rkd/') },
  fields: [
    {
      name: 'name',
      kind: 'text',
      path: `${SCHEMA_ORG}name`,
      locales: ['und'],
      output: true,
      searchable: { weight: 1 },
    },
    {
      name: 'sameAs',
      kind: 'reference',
      path: `${SCHEMA_ORG}sameAs`,
      array: true,
    },
    {
      name: 'birthDate',
      kind: 'keyword',
      path: `${SCHEMA_ORG}birthDate`,
      output: true,
    },
  ],
});

const organization = defineSearchType({
  name: 'Organization',
  class: `${SCHEMA_ORG}Organization`,
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
    {
      name: 'location',
      kind: 'keyword',
      path: `${SCHEMA_ORG}location`,
      output: true,
    },
  ],
});

/** A plain lookup at the root, faceted: what the issue was filed against. */
const work = defineSearchType({
  name: 'Work',
  class: `${SCHEMA_ORG}CreativeWork`,
  fields: [
    {
      name: 'creator',
      kind: 'reference',
      path: `${SCHEMA_ORG}creator`,
      array: true,
      output: true,
      filterable: true,
      facetable: true,
      ref: { strategy: 'lookup', target: ['Person', 'Organization'] },
    },
  ],
});

/** The same range, one level in: an edge nesting a `local` lookup. */
const creatorEdge = defineSearchType({
  name: 'CreatorEdge',
  fields: [
    {
      name: 'role',
      kind: 'keyword',
      path: `${SCHEMA_ORG}roleName`,
      output: true,
    },
    {
      name: 'creator',
      kind: 'reference',
      path: `${SCHEMA_ORG}creator`,
      output: true,
      ref: {
        strategy: 'lookup',
        target: ['Person', 'Organization'],
        local: true,
      },
    },
  ],
});

const edgedWork = defineSearchType({
  name: 'EdgedWork',
  class: `${SCHEMA_ORG}Painting`,
  fields: [
    {
      name: 'creator',
      kind: 'reference',
      path: `${SCHEMA_ORG}creator`,
      array: true,
      output: true,
      filterable: true,
      facetable: true,
      ref: { strategy: 'inline', typeName: 'CreatorEdge', identity: 'creator' },
    },
  ],
});

const schema = searchSchema(work, edgedWork, person, organization, creatorEdge);

const RKD = 'https://rkd/artists/1';
const rembrandt = {
  '@id': 'https://id.example/rembrandt',
  '@type': [`${SCHEMA_ORG}Person`, `${SCHEMA_ORG}Thing`],
  [alias('Person', 'name')]: [{ '@value': 'Rembrandt' }],
  [alias('Person', 'sameAs')]: [{ '@id': RKD }],
};
const sisters = {
  '@id': 'https://id.example/zusters',
  '@type': `${SCHEMA_ORG}Organization`,
  [alias('Organization', 'name')]: [{ '@value': 'Zusters Benedictinessen' }],
};
/** Typed as neither: the fallback case. */
const untyped = {
  '@id': 'https://id.example/unknown',
  [alias('Person', 'name')]: [{ '@value': 'Onbekend' }],
};

describe('declaring several targets', () => {
  it('reads them in order, through one shape for one and for many', () => {
    expect(referencedTargetsOf(work.fields[0], schema)).toEqual([
      person,
      organization,
    ]);
    expect(labelTargetNamesOf(edgedWork.fields[0], schema)).toEqual([
      'Person',
      'Organization',
    ]);
    expect(localLookupTargetsOf(creatorEdge.fields[1], schema)).toEqual([
      person,
      organization,
    ]);
    expect(localLookupTargetsOf(work.fields[0], schema)).toEqual([]);
  });

  it('inherits each target’s facet policy under its own name', () => {
    const policies = inheritedFacetPolicies(work.fields[0], schema);
    expect([...policies.keys()]).toEqual(['Person']);
    // A policy anywhere among the targets earns the field a facet companion.
    expect(physicalFields(work.fields[0], schema).facet).toBe('creator_facet');
  });

  it('rejects a target named twice: order is precedence, and a rank cannot be held twice', () => {
    expect(
      validateSearchType({
        name: 'Work',
        class: `${SCHEMA_ORG}CreativeWork`,
        fields: [
          {
            name: 'creator',
            kind: 'reference',
            output: true,
            ref: { strategy: 'lookup', target: ['Person', 'Person'] },
          },
        ],
      }),
    ).toContainEqual({ field: 'creator', reason: 'duplicate-target' });
  });

  it('rejects an empty target list as naming no type at all', () => {
    expect(
      validateSearchType({
        name: 'Work',
        class: `${SCHEMA_ORG}CreativeWork`,
        fields: [
          {
            name: 'creator',
            kind: 'reference',
            output: true,
            ref: { strategy: 'lookup', target: [] },
          },
        ],
      }),
    ).toContainEqual({ field: 'creator', reason: 'missing-ref-type-name' });
  });

  it('refuses joinable: an engine reference names one collection', () => {
    expect(
      validateSearchType({
        name: 'Work',
        class: `${SCHEMA_ORG}CreativeWork`,
        fields: [
          {
            name: 'creator',
            kind: 'reference',
            joinable: true,
            ref: { strategy: 'lookup', target: ['Person', 'Organization'] },
          },
        ],
      }),
    ).toContainEqual({
      field: 'creator',
      reason: 'joinable-with-several-targets',
    });
  });

  it('reserves the discriminator’s name', () => {
    expect(
      validateSearchType({
        name: 'Person',
        class: `${SCHEMA_ORG}Person`,
        fields: [{ name: TARGET_FIELD, kind: 'keyword', output: true }],
      }),
    ).toContainEqual({ field: TARGET_FIELD, reason: 'reserved-field-name' });
  });

  it('resolves every named target, not just the first', () => {
    expect(() =>
      searchSchema(person, {
        name: 'Work',
        class: `${SCHEMA_ORG}CreativeWork`,
        fields: [
          {
            name: 'creator',
            kind: 'reference',
            output: true,
            ref: { strategy: 'lookup', target: ['Person', 'Nowhere'] },
          },
        ],
      }),
    ).toThrow(/names unknown label source “Nowhere”/);
  });

  it('rejects targets that declare one field differently', () => {
    // A referent of either kind is stored in one nested object, so a field
    // the targets share must be one shape.
    const otherOrganization = defineSearchType({
      ...organization,
      fields: [
        organization.fields[0],
        {
          name: 'birthDate',
          kind: 'date',
          path: `${SCHEMA_ORG}foundingDate`,
          output: true,
        },
      ],
    });
    expect(() => searchSchema(work, person, otherOrganization)).toThrow(
      /both declare “birthDate” but not alike \(keyword vs date\)/,
    );
    // Arity counts too: one nested object cannot hold a value and a list
    // under one name.
    const listedOrganization = defineSearchType({
      ...organization,
      fields: [
        organization.fields[0],
        {
          name: 'birthDate',
          kind: 'keyword',
          array: true,
          path: `${SCHEMA_ORG}foundingDate`,
          output: true,
        },
      ],
    });
    expect(() => searchSchema(work, person, listedOrganization)).toThrow(
      /not alike \(keyword vs keyword list\)/,
    );
    // So does everything else that decides the stored shape: a Role, and for
    // a reference what it points at and whether it stores a copy.
    const filteringOrganization = defineSearchType({
      ...organization,
      fields: [
        organization.fields[0],
        {
          name: 'birthDate',
          kind: 'keyword',
          path: `${SCHEMA_ORG}foundingDate`,
          output: true,
          filterable: true,
        },
      ],
    });
    expect(() => searchSchema(work, person, filteringOrganization)).toThrow(
      /not alike \(keyword vs keyword \(filterable\)\)/,
    );
    const place = defineSearchType({
      name: 'Place',
      class: `${SCHEMA_ORG}Place`,
      fields: [
        {
          name: 'label',
          kind: 'text',
          path: `${SCHEMA_ORG}name`,
          locales: ['und'],
          output: true,
          searchable: { weight: 1 },
        },
      ],
    });
    const address = (local: boolean) => ({
      name: 'address',
      kind: 'reference' as const,
      path: `${SCHEMA_ORG}address`,
      output: true,
      ref: { strategy: 'lookup' as const, target: 'Place', local },
    });
    expect(() =>
      searchSchema(
        work,
        place,
        defineSearchType({
          ...person,
          fields: [...person.fields, address(false)],
        }),
        defineSearchType({
          ...organization,
          fields: [...organization.fields, address(true)],
        }),
      ),
    ).toThrow(
      /not alike \(reference → lookup Place vs reference → lookup Place local\)/,
    );
  });

  it('accepts an idOnly reference labelling its buckets from several sources', () => {
    const labelled = defineSearchType({
      name: 'Work',
      class: `${SCHEMA_ORG}CreativeWork`,
      fields: [
        {
          name: 'creator',
          kind: 'reference',
          path: `${SCHEMA_ORG}creator`,
          facetable: true,
          labelSource: ['Person', 'Organization'],
          ref: { strategy: 'idOnly' },
        },
      ],
    });
    const idOnly = searchSchema(labelled, person, organization);
    expect(labelTargetNamesOf(labelled.fields[0], idOnly)).toEqual([
      'Person',
      'Organization',
    ]);
  });
});

describe('reading a stored discriminator', () => {
  it('names the target stored, and falls back to the first where none is', () => {
    expect(
      storedTargetOf({ [TARGET_FIELD]: 'Organization' }, [
        person,
        organization,
      ]),
    ).toBe(organization);
    expect(
      storedTargetOf({ name_und: 'Onbekend' }, [person, organization]),
    ).toBe(person);
  });
});

describe('two targets nesting one name inline', () => {
  it('must nest the same Reference Type', () => {
    const addressOf = (typeName: string) => ({
      name: 'address',
      kind: 'reference' as const,
      path: `${SCHEMA_ORG}address`,
      output: true,
      ref: { strategy: 'inline' as const, typeName },
    });
    const postal = defineSearchType({
      name: 'PostalAddress',
      fields: [
        {
          name: 'street',
          kind: 'keyword',
          path: `${SCHEMA_ORG}streetAddress`,
          output: true,
        },
      ],
    });
    const visiting = defineSearchType({ ...postal, name: 'VisitingAddress' });
    expect(() =>
      searchSchema(
        work,
        postal,
        visiting,
        defineSearchType({
          ...person,
          fields: [...person.fields, addressOf('PostalAddress')],
        }),
        defineSearchType({
          ...organization,
          fields: [...organization.fields, addressOf('VisitingAddress')],
        }),
      ),
    ).toThrow(
      /reference → inline PostalAddress vs reference → inline VisitingAddress/,
    );
  });
});

describe('framing depth over several targets', () => {
  it('frames as far as the furthest target reaches', () => {
    // Person's key field is one more hop than Organization's fields: the
    // frame has to hold whichever declaration the referent turns out to match.
    expect(inlineFramingDepth(schema, edgedWork)).toBe(2);
    const shallow = searchSchema(
      defineSearchType({
        ...edgedWork,
        name: 'ShallowWork',
      }),
      defineSearchType({
        ...creatorEdge,
        fields: [
          creatorEdge.fields[0],
          {
            ...creatorEdge.fields[1],
            ref: { strategy: 'lookup', target: 'Organization', local: true },
          },
        ],
      }),
      organization,
    );
    expect(inlineFramingDepth(shallow, shallow.get(edgedWork.class)!)).toBe(2);
  });
});

describe('projecting a plain lookup over several targets', () => {
  const node = {
    '@id': 'https://ex/work/1',
    [alias('Work', 'creator')]: [rembrandt, sisters, untyped],
  };
  const document = projectDocument(node, work, schema);

  it('re-keys each referent through the target its rdf:type matches', () => {
    // The person through Person's key, the organization through nothing.
    expect(document.creator).toEqual([
      RKD,
      'https://id.example/zusters',
      'https://id.example/unknown',
    ]);
  });

  it('admits each id to a facet by the policy of its own target', () => {
    // The organization has no policy to fail; the untyped referent fell back
    // to the first target, whose policy it does not satisfy.
    expect(document.creator_facet).toEqual([RKD, 'https://id.example/zusters']);
  });

  it('judges a transformed id by its target still', () => {
    // A `transform` changes what the field stores; the policy is looked up by
    // the stored value, so the organization keeps its unconditional admission
    // and the person is still held to Person's policy.
    const transformed = defineSearchType({
      ...work,
      name: 'TransformedWork',
      fields: [
        {
          ...work.fields[0],
          transform: (value: string) => value.replace('https://', 'http://'),
        },
      ],
    });
    const projected = projectDocument(
      {
        ...node,
        [alias('TransformedWork', 'creator')]: node[alias('Work', 'creator')],
      },
      transformed,
      searchSchema(transformed, person, organization),
    );
    expect(projected.creator_facet).toEqual(['http://id.example/zusters']);
  });
});

describe('projecting a local lookup over several targets', () => {
  const node = {
    '@id': 'https://ex/work/2',
    [alias('EdgedWork', 'creator')]: [
      {
        [alias('CreatorEdge', 'role')]: [{ '@value': 'etser' }],
        [alias('CreatorEdge', 'creator')]: [rembrandt],
      },
      {
        [alias('CreatorEdge', 'role')]: [{ '@value': 'uitgever' }],
        [alias('CreatorEdge', 'creator')]: [sisters],
      },
      {
        [alias('CreatorEdge', 'role')]: [{ '@value': 'drukker' }],
        [alias('CreatorEdge', 'creator')]: [untyped],
      },
      {
        // Named inline as an organization, with no id: the case a collection
        // can never answer for, and the one the discriminator exists for.
        [alias('CreatorEdge', 'role')]: [{ '@value': 'opdrachtgever' }],
        [alias('CreatorEdge', 'creator')]: [
          {
            '@type': `${SCHEMA_ORG}Organization`,
            [alias('Organization', 'name')]: [{ '@value': 'Gemeente' }],
            [alias('Organization', 'location')]: [{ '@value': 'Maastricht' }],
          },
        ],
      },
    ],
  };
  const document = projectDocument(node, edgedWork, schema);
  const entries = document.creator as readonly SearchDocument[];
  const endpointOf = (index: number) =>
    entries[index].creator as SearchDocument;

  it('projects each endpoint through the target it matches, and says which', () => {
    expect(endpointOf(0)).toMatchObject({
      id: RKD,
      name_und: 'Rembrandt',
      [TARGET_FIELD]: 'Person',
    });
    expect(endpointOf(1)).toMatchObject({
      id: 'https://id.example/zusters',
      name_und: 'Zusters Benedictinessen',
      [TARGET_FIELD]: 'Organization',
    });
    expect(endpointOf(3)).toMatchObject({
      name_und: 'Gemeente',
      location: 'Maastricht',
      [TARGET_FIELD]: 'Organization',
    });
    expect(endpointOf(3)).not.toHaveProperty('id');
  });

  it('falls back to the first target declared for a referent matching none', () => {
    expect(endpointOf(2)).toMatchObject({
      id: 'https://id.example/unknown',
      [TARGET_FIELD]: 'Person',
    });
  });

  it('admits each harvested id to the facet by the policy of its own target', () => {
    expect(document.creator_id).toEqual([
      RKD,
      'https://id.example/zusters',
      'https://id.example/unknown',
    ]);
    expect(document.creator_id_facet).toEqual([
      RKD,
      'https://id.example/zusters',
    ]);
  });

  it('stores no discriminator for a lookup naming one target', () => {
    const single = searchSchema(
      defineSearchType({ ...edgedWork, name: 'SingleWork' }),
      defineSearchType({
        ...creatorEdge,
        fields: [
          creatorEdge.fields[0],
          {
            ...creatorEdge.fields[1],
            ref: { strategy: 'lookup', target: 'Person', local: true },
          },
        ],
      }),
      person,
    );
    const singleWork = single.get(edgedWork.class)!;
    const projected = projectDocument(
      {
        ...node,
        [alias('SingleWork', 'creator')]: node[alias('EdgedWork', 'creator')],
      },
      singleWork,
      single,
    );
    const [first] = projected.creator as readonly SearchDocument[];
    expect(first.creator).not.toHaveProperty(TARGET_FIELD);
  });
});

describe('validating a projection over several targets', () => {
  const base = {
    where: [],
    orderBy: [],
    limit: 10,
    offset: 0,
    facets: [],
    locale: 'nl',
  };

  it('accepts a field any target serves, and rejects one none does', () => {
    expect(
      validateQuery(
        {
          ...base,
          resolve: { creator: { fields: ['birthDate', 'location'] } },
        },
        work,
        schema,
      ),
    ).toEqual([]);
    expect(
      validateQuery(
        { ...base, resolve: { creator: { fields: ['deathDate'] } } },
        work,
        schema,
      ),
    ).toEqual([
      { part: 'resolve', field: 'creator.deathDate', reason: 'unknown-field' },
    ]);
  });
});
