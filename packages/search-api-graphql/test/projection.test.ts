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
    {
      name: 'mentor',
      kind: 'reference',
      output: true,
      ref: { strategy: 'lookup', target: 'Person' },
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
    {
      name: 'parent',
      kind: 'reference',
      output: true,
      ref: { strategy: 'lookup', target: 'Organization' },
    },
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
  projectionFor(infoFor(query) as never, work, schema);

describe('projectionFor', () => {
  it('asks for the fields a selection names, per lookup', () => {
    expect(
      project(`{ creativeWorks { items { title author { id name } } } }`),
    ).toEqual({ author: { fields: ['name'] } });
  });

  it('asks for no meta-field, so a client that injects __typename still works', () => {
    // Apollo Client and urql add `__typename` to every selection set. Carried
    // into the projection it would reach `assertValidQuery` as an unknown
    // field of the target and fail the whole search.
    expect(
      project(`{ creativeWorks { items { author { name __typename } } } }`),
    ).toEqual({ author: { fields: ['name'] } });
  });

  it('asks for nothing the target does not declare', () => {
    expect(
      project(`{ creativeWorks { items { author { name nonexistent } } } }`),
    ).toEqual({ author: { fields: ['name'] } });
  });

  it('merges the level below when one lookup is selected twice', () => {
    // Two fragments each spreading `author` is idiomatic; the deeper levels
    // must union, not replace, or a field the client asked for is never
    // fetched and comes back null.
    expect(
      project(`
        {
          creativeWorks {
            items {
              author { employer { label } }
              author { employer { homepage } }
            }
          }
        }
      `),
    ).toEqual({
      author: {
        fields: ['employer'],
        resolve: { employer: { fields: ['label', 'homepage'] } },
      },
    });
  });

  it('reads what it can from a query naming what it cannot resolve', () => {
    // An undefined fragment and a target this schema does not hold: both parse,
    // neither validates. Projecting what remains keeps this a reading of the
    // query rather than a second validator.
    expect(
      project(`{ creativeWorks { items { author { name } ...missing } } }`),
    ).toEqual({ author: { fields: ['name'] } });
    // An unresolvable TARGET is deliberately not tested beside it: the
    // projection reads the schema itself now, and `searchSchema` rejects a
    // lookup whose target it cannot resolve – so that case cannot be built.
  });

  it('keeps both deeper lookups when two selections name different ones', () => {
    expect(
      project(`
        {
          creativeWorks {
            items {
              author { employer { label } }
              author { mentor { name } }
            }
          }
        }
      `),
    ).toEqual({
      author: {
        fields: ['employer', 'mentor'],
        resolve: {
          employer: { fields: ['label'] },
          mentor: { fields: ['name'] },
        },
      },
    });
  });

  it('merges recursively, so a repeated middle level keeps both subtrees', () => {
    expect(
      project(`
        {
          creativeWorks {
            items {
              author { employer { parent { label } } }
              author { employer { parent { homepage } } }
            }
          }
        }
      `),
    ).toEqual({
      author: {
        fields: ['employer'],
        resolve: {
          employer: {
            fields: ['parent'],
            resolve: { parent: { fields: ['label', 'homepage'] } },
          },
        },
      },
    });
  });

  it('keeps a deeper level a second selection of the same lookup omits', () => {
    // The second `employer` carries no sub-selection, so it asks for nothing
    // deeper – but it must not erase what the first one asked for.
    expect(
      project(`
        {
          creativeWorks {
            items {
              author { employer { label } }
              author { employer }
            }
          }
        }
      `),
    ).toEqual({
      author: {
        fields: ['employer'],
        resolve: { employer: { fields: ['label'] } },
      },
    });
  });

  it('keeps a deeper level when the second selection of a lookup has none', () => {
    expect(
      project(`
        {
          creativeWorks {
            items {
              author { employer { label } }
              author { name }
            }
          }
        }
      `),
    ).toEqual({
      author: {
        fields: ['employer', 'name'],
        resolve: { employer: { fields: ['label'] } },
      },
    });
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
