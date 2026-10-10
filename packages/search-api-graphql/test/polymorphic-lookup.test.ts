import { describe, expect, it } from 'vitest';
import {
  graphql,
  Kind,
  parse,
  printSchema,
  type FragmentDefinitionNode,
  type OperationDefinitionNode,
} from 'graphql';
import {
  NESTED_DOCUMENT_TYPE,
  searchSchema,
  type FacetsOutcome,
  type SearchEngine,
  type SearchField,
  type SearchQuery,
  type SearchResult,
  type SearchType,
} from '@lde/search';
import { buildGraphQLSchema } from '../src/build-schema.js';
import { projectionFor } from '../src/projection.js';

const person: SearchType = {
  name: 'Person',
  class: 'https://schema.org/Person',
  labelField: 'name',
  fields: [
    {
      name: 'name',
      kind: 'text',
      locales: ['nl'],
      output: true,
      searchable: { weight: 1 },
    },
    { name: 'birthDate', kind: 'keyword', output: true },
    // Shared with Organization, but required only here: the interface offers
    // it with the weaker promise.
    { name: 'homepage', kind: 'keyword', output: true, required: true },
    {
      name: 'birthPlace',
      kind: 'reference',
      output: true,
      ref: { strategy: 'lookup', target: 'Place' },
    },
    // Shared, and pointing at one type on both: reaches the interface.
    {
      name: 'address',
      kind: 'reference',
      output: true,
      ref: { strategy: 'lookup', target: 'Place' },
    },
  ],
};
const organization: SearchType = {
  name: 'Organization',
  class: 'https://schema.org/Organization',
  labelField: 'name',
  fields: [
    {
      name: 'name',
      kind: 'text',
      locales: ['nl'],
      output: true,
      searchable: { weight: 1 },
    },
    { name: 'location', kind: 'keyword', output: true },
    { name: 'homepage', kind: 'keyword', output: true },
    {
      name: 'address',
      kind: 'reference',
      output: true,
      ref: { strategy: 'lookup', target: 'Place' },
    },
  ],
};
const place: SearchType = {
  name: 'Place',
  class: 'https://schema.org/Place',
  fields: [
    {
      name: 'label',
      kind: 'text',
      locales: ['nl'],
      output: true,
      searchable: { weight: 1 },
    },
  ],
};
const work: SearchType = {
  name: 'CreativeWork',
  class: 'https://schema.org/CreativeWork',
  fields: [
    { name: 'title', kind: 'text', locales: ['nl'], output: true },
    {
      name: 'creator',
      kind: 'reference',
      array: true,
      output: true,
      filterable: true,
      facetable: true,
      ref: { strategy: 'lookup', target: ['Person', 'Organization'] },
    },
    // A second field naming the same targets meets the same interface.
    {
      name: 'contributor',
      kind: 'reference',
      array: true,
      output: true,
      ref: { strategy: 'lookup', target: ['Person', 'Organization'] },
    },
  ],
};
const schema = searchSchema(work, person, organization, place);
const gqlSchema = buildGraphQLSchema(schema);
const sdl = printSchema(gqlSchema);

describe('serving a lookup over several targets', () => {
  it('emits one interface per target set, implemented by each target’s reference type', () => {
    expect(sdl).toMatch(
      /interface PersonOrOrganizationReference \{\s+id: IRI!\s+name: \[LanguageString!\]!\s+homepage: String\s+address: PlaceReference\s+\}/,
    );
    expect(sdl).toMatch(
      /type PersonReference implements PersonOrOrganizationReference \{/,
    );
    expect(sdl).toMatch(
      /type OrganizationReference implements PersonOrOrganizationReference \{/,
    );
    expect(sdl).toMatch(/creator: \[PersonOrOrganizationReference!\]!/);
    expect(sdl).toMatch(/contributor: \[PersonOrOrganizationReference!\]!/);
    expect(
      sdl.match(/^interface PersonOrOrganizationReference /gm),
    ).toHaveLength(1);
    // Only what every target carries alike reaches the interface.
    expect(sdl).not.toMatch(
      /interface PersonOrOrganizationReference \{[^}]*birthDate/,
    );
    expect(sdl).not.toMatch(
      /interface PersonOrOrganizationReference \{[^}]*location/,
    );
    // The members keep everything of their own, promises included.
    expect(sdl).toMatch(
      /type PersonReference implements[^}]*homepage: String!/,
    );
    expect(sdl).toMatch(
      /type PersonReference implements[^}]*birthDate: String/,
    );
  });

  it('refuses a declaration spelling the derived name itself', () => {
    // A Reference Type named `PersonOrOrganization` would put its filter
    // under the interface's filter name; refused rather than served wrongly.
    const spelled: SearchType = {
      name: 'PersonOrOrganization',
      fields: [{ name: 'note', kind: 'keyword', output: true }],
    };
    const nesting = (fields: readonly SearchField[]): SearchType => ({
      ...work,
      fields,
    });
    const note: SearchField = {
      name: 'note',
      kind: 'reference',
      output: true,
      ref: { strategy: 'inline', typeName: 'PersonOrOrganization' },
    };
    // Whichever registers first, the other is refused.
    for (const fields of [
      [...work.fields, note],
      [note, ...work.fields],
    ]) {
      expect(() =>
        buildGraphQLSchema(
          searchSchema(nesting(fields), person, organization, place, spelled),
        ),
      ).toThrow(/collides with another type name/);
    }
  });

  it('refuses a declaration spelling the derived name itself', () => {
    // A Reference Type named `PersonOrOrganization` would put its filter
    // under the interface's filter name; refused rather than served wrongly.
    const spelled: SearchType = {
      name: 'PersonOrOrganization',
      fields: [{ name: 'note', kind: 'keyword', output: true }],
    };
    const nesting = (fields: readonly SearchField[]): SearchType => ({
      ...work,
      fields,
    });
    const note: SearchField = {
      name: 'note',
      kind: 'reference',
      output: true,
      ref: { strategy: 'inline', typeName: 'PersonOrOrganization' },
    };
    // Whichever registers first, the other is refused.
    for (const fields of [
      [...work.fields, note],
      [note, ...work.fields],
    ]) {
      expect(() =>
        buildGraphQLSchema(
          searchSchema(nesting(fields), person, organization, place, spelled),
        ),
      ).toThrow(/collides with another type name/);
    }
  });

  it('shares a reference field only where every target points it at one type', () => {
    // Person.affiliation looks up an Organization, Organization.affiliation a
    // Place: two emitted types, so the interface offers neither.
    expect(sdl).not.toMatch(
      /interface PersonOrOrganizationReference \{[^}]*affiliation/,
    );
  });

  it('refuses a declaration whose derived interface name is taken', () => {
    expect(() =>
      buildGraphQLSchema(
        searchSchema(work, person, organization, place, {
          name: 'PersonOrOrganizationReference',
          class: 'https://schema.org/Thing',
          fields: [{ name: 'note', kind: 'keyword', output: true }],
        }),
      ),
    ).toThrow(/would be served as “PersonOrOrganizationReference”/);
  });

  it('types the filter by the target set, still over IRIs', () => {
    expect(sdl).toMatch(
      /input PersonOrOrganizationFilter \{\s+in: \[IRI!\]\s+\}/,
    );
    expect(sdl).toMatch(
      /input CreativeWorkCriterion @oneOf \{[^}]*creator: PersonOrOrganizationFilter/,
    );
  });

  it('reports the target each referent came from, and serves its own fields through a fragment', async () => {
    const engine: SearchEngine = {
      schema,
      async search(): Promise<SearchResult> {
        return {
          total: 1,
          facets: {},
          hits: [
            {
              id: 'https://w/1',
              document: {
                title: { nl: ['Werk'] },
                creator: [
                  {
                    id: 'https://p/1',
                    name: { nl: ['Frank Koel'] },
                    birthDate: '1901',
                    [NESTED_DOCUMENT_TYPE]: 'Person',
                  },
                  {
                    id: 'https://o/1',
                    name: { nl: ['Zusters Franciscanessen'] },
                    location: 'Roermond',
                    [NESTED_DOCUMENT_TYPE]: 'Organization',
                  },
                  // Untyped – a hand-built document – reads as the first.
                  { id: 'https://x/1', name: { nl: ['Onbekend'] } },
                ],
              },
            },
          ],
        };
      },
      searchFacets: async (
        _searchType: SearchType,
        queries: readonly SearchQuery[],
      ): Promise<readonly FacetsOutcome[]> =>
        queries.map(() => ({ facets: {} })),
    };

    const result = await graphql({
      schema: gqlSchema,
      source: `{
        creativeWorks {
          items {
            creator {
              __typename
              id
              name { value }
              ... on PersonReference { birthDate }
              ... on OrganizationReference { location }
            }
          }
        }
      }`,
      contextValue: { engine, acceptLanguage: ['nl'] },
    });

    expect(result.errors).toBeUndefined();
    const [item] = (result.data as { creativeWorks: { items: unknown[] } })
      .creativeWorks.items;
    expect(item).toEqual({
      creator: [
        {
          __typename: 'PersonReference',
          id: 'https://p/1',
          name: [{ value: 'Frank Koel' }],
          birthDate: '1901',
        },
        {
          __typename: 'OrganizationReference',
          id: 'https://o/1',
          name: [{ value: 'Zusters Franciscanessen' }],
          location: 'Roermond',
        },
        {
          __typename: 'PersonReference',
          id: 'https://x/1',
          name: [{ value: 'Onbekend' }],
          birthDate: null,
        },
      ],
    });
  });
});

describe('projecting a selection over several targets', () => {
  function infoFor(query: string) {
    const document = parse(query);
    const operation = document.definitions.find(
      (definition): definition is OperationDefinitionNode =>
        definition.kind === Kind.OPERATION_DEFINITION,
    );
    const fragments = Object.fromEntries(
      document.definitions
        .filter(
          (definition): definition is FragmentDefinitionNode =>
            definition.kind === Kind.FRAGMENT_DEFINITION,
        )
        .map((fragment) => [fragment.name.value, fragment]),
    );
    return {
      fieldNodes: operation!.selectionSet.selections.filter(
        (selection) => selection.kind === Kind.FIELD,
      ),
      fragments,
    };
  }

  it('asks for what any target serves, fragments included, and descends each target’s own lookups', () => {
    expect(
      projectionFor(
        infoFor(`{
          creativeWorks {
            items {
              creator {
                __typename
                id
                name { value }
                ... on PersonReference { birthDate birthPlace { label { value } } }
                ... on OrganizationReference { location }
                address { label { value } }
              }
            }
          }
        }`) as never,
        work,
        schema,
      ),
    ).toEqual({
      creator: {
        fields: ['name', 'birthDate', 'birthPlace', 'location', 'address'],
        resolve: {
          birthPlace: { fields: ['label'] },
          address: { fields: ['label'] },
        },
      },
    });
  });
});
