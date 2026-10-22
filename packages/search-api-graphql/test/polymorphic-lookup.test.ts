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
    // A referent no collection holds is served as neither target.
    expect(sdl).toMatch(
      /type PersonOrOrganizationUnresolvedReference implements PersonOrOrganizationReference \{\s+id: IRI!\s+name: \[LanguageString!\]!\s+homepage: String\s+address: PlaceReference\s+\}/,
    );
  });

  it('offers a nullable id where a local lookup may store an unidentified referent', () => {
    const local = printSchema(
      buildGraphQLSchema(
        searchSchema(
          {
            ...work,
            fields: [
              {
                name: 'creator',
                kind: 'reference',
                output: true,
                ref: {
                  strategy: 'lookup',
                  target: ['Person', 'Organization'],
                  local: true,
                },
              },
            ],
          },
          person,
          organization,
          place,
        ),
      ),
    );
    expect(local).toMatch(
      /interface PersonOrOrganizationReference \{\s+id: IRI\s/,
    );
    expect(local).toMatch(
      /type PersonOrOrganizationUnresolvedReference implements PersonOrOrganizationReference \{\s+id: IRI\s/,
    );
  });

  it('offers a field every target requires as nullable, since an unresolved referent carries none of it', () => {
    const requiring = (searchType: SearchType): SearchType => ({
      ...searchType,
      fields: searchType.fields.map((declared) =>
        declared.name === 'homepage'
          ? ({ ...declared, required: true } as SearchField)
          : declared,
      ),
    });
    const required = printSchema(
      buildGraphQLSchema(
        searchSchema(work, requiring(person), requiring(organization), place),
      ),
    );
    expect(required).toMatch(
      /interface PersonOrOrganizationReference \{[^}]*homepage: String\s/,
    );
    expect(required).toMatch(
      /type OrganizationReference implements[^}]*homepage: String!/,
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

  it('refuses a declared type beside a non-output lookup filtered under the derived name', () => {
    // No interface is registered without `output`, but the filter is still
    // named for the set – so a root type `PersonOrOrganization`, whose `id`
    // is filtered through its own name, collides there.
    const spelled: SearchType = {
      name: 'PersonOrOrganization',
      class: 'https://example.org/PersonOrOrganization',
      fields: [{ name: 'note', kind: 'keyword', output: true }],
    };
    const filtered: SearchType = {
      name: 'CreativeWork',
      class: 'https://schema.org/CreativeWork',
      fields: [
        { name: 'title', kind: 'text', locales: ['nl'], output: true },
        {
          name: 'creator',
          kind: 'reference',
          filterable: true,
          ref: { strategy: 'lookup', target: ['Person', 'Organization'] },
        },
      ],
    };
    expect(() =>
      buildGraphQLSchema(
        searchSchema(filtered, person, organization, place, spelled),
      ),
    ).toThrow(/joined name of a lookup’s targets/);
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

  it('names the targets in its descriptions, with no article to get wrong', () => {
    expect(
      gqlSchema.getType('PersonOrOrganizationReference')?.description,
    ).toMatch(/^A reference whose target is Person or Organization;/);
    expect(
      gqlSchema.getType('PersonOrOrganizationUnresolvedReference')?.description,
    ).toMatch(/^A reference whose target is Person or Organization, but /);
    expect(gqlSchema.getType('PersonOrOrganizationFilter')?.description).toBe(
      'Matches a field holding IRIs of Person or Organization.',
    );
    expect(gqlSchema.getType('PersonFilter')?.description).toBe(
      'Matches a field holding IRIs of Person.',
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
                  // Untyped: no collection answered for it, so no target
                  // may be claimed for it.
                  { id: 'https://x/1' },
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
          __typename: 'PersonOrOrganizationUnresolvedReference',
          id: 'https://x/1',
          name: [],
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
