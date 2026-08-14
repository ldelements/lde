import { describe, expect, it } from 'vitest';
import {
  Kind,
  parse,
  type FragmentDefinitionNode,
  type OperationDefinitionNode,
} from 'graphql';
import { searchSchema, type SearchType } from '@lde/search';
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
    {
      name: 'employer',
      kind: 'reference',
      output: true,
      ref: { strategy: 'lookup', target: 'Organization' },
    },
  ],
};
const organization: SearchType = {
  name: 'Organization',
  class: 'https://schema.org/Organization',
  fields: [
    {
      name: 'label',
      kind: 'text',
      locales: ['nl'],
      output: true,
      searchable: { weight: 1 },
    },
    { name: 'homepage', kind: 'keyword', output: true },
  ],
};
const work: SearchType = {
  name: 'CreativeWork',
  class: 'https://schema.org/CreativeWork',
  fields: [
    { name: 'title', kind: 'text', locales: ['nl'], output: true },
    {
      name: 'author',
      kind: 'reference',
      output: true,
      ref: { strategy: 'lookup', target: 'Person' },
    },
    // Neither strategy is resolved by a projection: an idOnly reference is a
    // bare IRI, and an inline one is carried by the hit itself.
    {
      name: 'license',
      kind: 'reference',
      output: true,
      ref: { strategy: 'idOnly' },
    },
  ],
};
const schema = searchSchema(person, organization, work);
const byName = new Map(
  [...schema.values()].map((rootType) => [rootType.name, rootType]),
);

/** The `{ fieldNodes, fragments }` a resolver would receive for `query`. */
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

const project = (query: string) =>
  projectionFor(infoFor(query) as never, work, (target) => byName.get(target));

describe('projectionFor', () => {
  it('asks for the fields a selection names, per lookup', () => {
    expect(
      project(`{ creativeWorks { items { title author { id name } } } }`),
    ).toEqual({ author: { fields: ['name'] } });
  });

  it('nests, so each level fetches what that level selected', () => {
    expect(
      project(
        `{ creativeWorks { items { author { name employer { label } } } } }`,
      ),
    ).toEqual({
      author: {
        fields: ['name', 'employer'],
        resolve: { employer: { fields: ['label'] } },
      },
    });
  });

  it('asks for nothing when only `id` is selected: it is already on the hit', () => {
    expect(project(`{ creativeWorks { items { author { id } } } }`)).toEqual({
      author: { fields: [] },
    });
  });

  it('projects no reference that a lookup does not resolve', () => {
    // `license` is idOnly – a bare IRI, with no collection to read from.
    expect(
      project(`{ creativeWorks { items { title license } } }`),
    ).toBeUndefined();
  });

  it('follows fragments, including inline ones', () => {
    expect(
      project(`
        { creativeWorks { items { ...authorFields ... on CreativeWork { title } } } }
        fragment authorFields on CreativeWork { author { name } }
      `),
    ).toEqual({ author: { fields: ['name'] } });
  });

  it('merges selections of one lookup made in two places', () => {
    expect(
      project(`
        { creativeWorks { items { author { name } ...more } } }
        fragment more on CreativeWork { author { employer { label } } }
      `),
    ).toEqual({
      author: {
        fields: ['name', 'employer'],
        resolve: { employer: { fields: ['label'] } },
      },
    });
  });

  it('projects nothing from a selection GraphQL would have rejected', () => {
    // A lookup selected with no sub-selection, and a root field with none:
    // both parse, neither validates. Projecting them as empty keeps this a
    // pure reading of the query rather than a second validator.
    expect(project(`{ creativeWorks { items { author } } }`)).toEqual({
      author: { fields: [] },
    });
    expect(project(`{ creativeWorks }`)).toBeUndefined();
  });

  it('projects nothing for a query that selects no hits', () => {
    expect(
      project(`{ creativeWorks { pagination { total } } }`),
    ).toBeUndefined();
  });
});
