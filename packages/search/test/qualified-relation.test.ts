import { describe, expect, it } from 'vitest';
import { projectDocument, type SearchDocument } from '../src/project.js';
import {
  defineSearchType,
  inlineFramingDepth,
  labelTargetNameOf,
  physicalFields,
  searchSchema,
} from '../src/schema.js';
import { resolvePath, validateQuery, type SearchQuery } from '../src/query.js';
import type { SearchType } from '../src/schema.js';

const SCHEMA_ORG = 'https://schema.org/';
const RKD = 'https://rkd.example/104628';

// The extraction CONSTRUCT emits each value under its field’s IR Alias, so a
// framed node is keyed by (declaring type, field) – never by the source path.
const alias = (type: string, field: string) => `urn:lde:${type}/${field}`;
const workKey = (field: string) => alias('Work', field);
const edgeKey = (field: string) => alias('CreatorEdge', field);
const personKey = (field: string) => alias('Person', field);

/**
 * The endpoint’s own collection, keyed on an alignment field. That key is what
 * makes the framing hop load-bearing: it is read off the PERSON node, which
 * sits two hops from the work once an edge stands between them.
 */
const person = defineSearchType({
  name: 'Person',
  class: `${SCHEMA_ORG}Person`,
  key: { field: 'sameAs' },
  fields: [
    {
      name: 'label',
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
  ],
});

/** The edge: its own value, plus the reference identifying the endpoint. */
const creatorEdge = defineSearchType({
  name: 'CreatorEdge',
  fields: [
    {
      name: 'role',
      kind: 'keyword',
      path: `${SCHEMA_ORG}name`,
      output: true,
      filterable: true,
    },
    {
      name: 'creator',
      kind: 'reference',
      path: `${SCHEMA_ORG}creator`,
      output: true,
      ref: { strategy: 'lookup', target: 'Person', local: true },
    },
  ],
});

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
      ref: { strategy: 'inline', typeName: 'CreatorEdge', identity: 'creator' },
    },
  ],
});

const schema = searchSchema(work, person, creatorEdge);

/** One work with an identified creator in a role, and an unidentified one. */
const node = {
  '@id': 'https://ex/work/1',
  [workKey('creator')]: [
    {
      [edgeKey('role')]: [{ '@value': 'etser' }],
      [edgeKey('creator')]: [
        {
          '@id': 'https://id.example/person/rembrandt',
          [personKey('label')]: [{ '@value': 'Rembrandt van Rijn' }],
          [personKey('sameAs')]: [{ '@id': RKD }],
        },
      ],
    },
    {
      [edgeKey('role')]: [{ '@value': 'auteur' }],
      [edgeKey('creator')]: [
        { [personKey('label')]: [{ '@value': 'Jan Jansen' }] },
      ],
    },
  ],
};

const entriesOf = (document: SearchDocument) =>
  document.creator as readonly SearchDocument[];

describe('an edge that carries data and resolves a lookup', () => {
  it('nests one entry per edge, carrying the edge’s own value', () => {
    const entries = entriesOf(projectDocument(node, work, schema));

    expect(entries).toHaveLength(2);
    expect(entries[0].role).toBe('etser');
    expect(entries[1].role).toBe('auteur');
  });

  it('re-keys an identified endpoint through the target’s key field', () => {
    // Stored as the key the Person collection files the document under, not as
    // the IRI the publisher minted – otherwise the lookup resolves nothing at
    // query time and every endpoint degrades to a bare id, in silence.
    const entries = entriesOf(projectDocument(node, work, schema));
    const endpoint = entries[0].creator as SearchDocument;

    expect(endpoint.id).toBe(RKD);
    // Physical names: the projection writes what the engine stores, and
    // reconstruction gathers the display fields back into a language map.
    expect(endpoint.label_und).toBe('Rembrandt van Rijn');
  });

  it('carries an unidentified endpoint as an entry without an id', () => {
    // What `local` buys: without it this endpoint is invisible, because a
    // plain reference stores IRIs and an inline-named endpoint has none.
    const entries = entriesOf(projectDocument(node, work, schema));
    const endpoint = entries[1].creator as SearchDocument;

    expect(endpoint).not.toHaveProperty('id');
    expect(endpoint.label_und).toBe('Jan Jansen');
  });
});

describe('fanning an edge out into one entry per tuple', () => {
  // A weld asks whether ONE entry satisfies every condition, so a leaf a weld
  // can name holds one value. An edge the graph gave several fans out (ADR 26).

  /** Both leaves weldable, so both are tuple positions. */
  const weldableEdge = defineSearchType({
    name: 'CreatorEdge',
    fields: [
      {
        name: 'role',
        kind: 'keyword',
        path: `${SCHEMA_ORG}name`,
        output: true,
        filterable: true,
      },
      {
        name: 'creator',
        kind: 'reference',
        path: `${SCHEMA_ORG}creator`,
        output: true,
        filterable: true,
        ref: { strategy: 'lookup', target: 'Person', local: true },
      },
    ],
  });

  const twoRoles = {
    '@id': 'https://ex/work/2',
    [workKey('creator')]: [
      {
        [edgeKey('role')]: [{ '@value': 'etser' }, { '@value': 'drukker' }],
        [edgeKey('creator')]: [
          { '@id': 'https://a/1', [personKey('sameAs')]: [{ '@id': RKD }] },
        ],
      },
    ],
  };

  it('splits a multi-valued weldable leaf across entries', () => {
    const entries = entriesOf(projectDocument(twoRoles, work, schema));

    expect(entries).toHaveLength(2);
    expect(entries.map((entry) => entry.role)).toEqual(['etser', 'drukker']);
    // Every entry keeps the endpoint the edge stated: the tuple is what fans
    // out, not the edge's other values.
    expect(
      entries.map((entry) => (entry.creator as SearchDocument).id),
    ).toEqual([RKD, RKD]);
  });

  it('takes the product where two weldable leaves are multi-valued', () => {
    const twoOfEach = {
      '@id': 'https://ex/work/3',
      [workKey('creator')]: [
        {
          [edgeKey('role')]: [{ '@value': 'etser' }, { '@value': 'drukker' }],
          [edgeKey('creator')]: [
            { '@id': 'https://a/1', [personKey('sameAs')]: [{ '@id': RKD }] },
            { '@id': 'https://a/2' },
          ],
        },
      ],
    };
    const entries = entriesOf(
      projectDocument(
        twoOfEach,
        work,
        searchSchema(work, person, weldableEdge),
      ),
    );

    expect(entries.map((entry) => [entry.role, entry.creator_id])).toEqual([
      ['etser', RKD],
      ['etser', 'https://a/2'],
      ['drukker', RKD],
      ['drukker', 'https://a/2'],
    ]);
  });

  it('leaves an output-only list on the entry', () => {
    // Nothing welds it, so it needs no tuple position – and splitting the entry
    // over it would multiply entries for a value no filter can name.
    const noteEdge = defineSearchType({
      name: 'CreatorEdge',
      fields: [
        {
          name: 'role',
          kind: 'keyword',
          path: `${SCHEMA_ORG}name`,
          output: true,
          filterable: true,
        },
        {
          name: 'note',
          kind: 'keyword',
          path: `${SCHEMA_ORG}description`,
          array: true,
          output: true,
        },
        {
          name: 'creator',
          kind: 'reference',
          path: `${SCHEMA_ORG}creator`,
          output: true,
          ref: { strategy: 'lookup', target: 'Person', local: true },
        },
      ],
    });
    const annotated = {
      '@id': 'https://ex/work/6',
      [workKey('creator')]: [
        {
          [edgeKey('role')]: [{ '@value': 'etser' }],
          [edgeKey('note')]: [
            { '@value': 'gesigneerd' },
            { '@value': 'ovaal' },
          ],
        },
      ],
    };
    const entries = entriesOf(
      projectDocument(annotated, work, searchSchema(work, person, noteEdge)),
    );

    expect(entries).toHaveLength(1);
    expect(entries[0].note).toEqual(['gesigneerd', 'ovaal']);
  });

  it('does not fan a local lookup out over the endpoint’s own fields', () => {
    // A `local` lookup nests the endpoint's own Root Type, whose fields are
    // multi-valued for reasons of their own – `sameAs` here. Splitting on those
    // would scatter one person across entries; what a weld names is the flat
    // companion beside the object.
    const twoAlignments = {
      '@id': 'https://ex/work/7',
      [workKey('creator')]: [
        {
          [edgeKey('role')]: [{ '@value': 'etser' }],
          [edgeKey('creator')]: [
            {
              '@id': 'https://a/1',
              [personKey('sameAs')]: [{ '@id': RKD }, { '@id': 'https://a/9' }],
            },
          ],
        },
      ],
    };
    const entries = entriesOf(projectDocument(twoAlignments, work, schema));

    expect(entries).toHaveLength(1);
  });
});

describe('the identity companion', () => {
  it('harvests the ids the entries reference', () => {
    // The flat field an engine filters and facets in the nested object’s
    // place, holding the RE-KEYED ids – so filter and facet agree with what
    // the entries carry rather than with what the graph said.
    const document = projectDocument(node, work, schema);

    expect(document.creator_id).toEqual([RKD]);
  });

  it('leaves an unidentified endpoint out', () => {
    // Facets stay keyed on identity: an endpoint with no id contributes no
    // bucket, rather than one keyed on its label – which would merge two
    // different people who happen to share a name.
    const document = projectDocument(node, work, schema);

    expect(document.creator_id).toHaveLength(1);
    expect(document.creator_id).not.toContain('Jan Jansen');
  });

  it('is absent for an inline reference that declares no identity', () => {
    const displayOnly = defineSearchType({
      name: 'Work',
      class: `${SCHEMA_ORG}CreativeWork`,
      fields: [
        {
          name: 'creator',
          kind: 'reference',
          path: `${SCHEMA_ORG}creator`,
          array: true,
          output: true,
          ref: { strategy: 'inline', typeName: 'CreatorEdge' },
        },
      ],
    });
    const document = projectDocument(
      node,
      displayOnly,
      searchSchema(displayOnly, person, creatorEdge),
    );

    expect(document.creator).toHaveLength(2);
    expect(document).not.toHaveProperty('creator_id');
  });
});

describe('framing depth', () => {
  it('reaches past the edge to the endpoint’s own node', () => {
    // work → edge → person is two hops. At depth 1 the person’s triples are
    // outside the frame, so both the label and the key field read as absent.
    expect(inlineFramingDepth(schema, work)).toBe(2);
  });

  it('counts a traversing path as more than one hop', () => {
    // The same reach stated as a path instead of as nesting: a value two hops
    // out needs the intermediate node’s triples either way.
    const flat = defineSearchType({
      name: 'Flat',
      class: `${SCHEMA_ORG}CreativeWork`,
      fields: [
        {
          name: 'creatorName',
          kind: 'text',
          path: `<${SCHEMA_ORG}creator>/<${SCHEMA_ORG}name>`,
          locales: ['und'],
          output: true,
        },
      ],
    });

    expect(inlineFramingDepth(searchSchema(flat), flat)).toBe(1);
  });

  it('does not mistake the slashes in a bare IRI for a traversal', () => {
    // A path with no delimiters is one term, however many slashes its IRI
    // carries: `?s a/b ?o` does not parse, so a sequence is only expressible
    // with each IRI in angle brackets.
    const bare = defineSearchType({
      name: 'Bare',
      class: `${SCHEMA_ORG}CreativeWork`,
      fields: [
        {
          name: 'name',
          kind: 'text',
          path: `${SCHEMA_ORG}name`,
          locales: ['und'],
          output: true,
        },
      ],
    });

    expect(inlineFramingDepth(searchSchema(bare), bare)).toBe(1);
  });
});

describe('addressing a nested field from a criterion', () => {
  const base: SearchQuery = {
    where: [],
    orderBy: [],
    limit: 10,
    offset: 0,
    facets: [],
    locale: 'nl',
  };

  it('walks into an inline reference and constrains the field there', () => {
    // `where: { creator: { where: { role: … } } }` at the surface. The hop
    // stays inside the document, so it costs no round trip and spends none of
    // the join budget.
    expect(
      validateQuery(
        {
          ...base,
          where: [{ or: [{ on: ['creator'], field: 'role', in: ['etser'] }] }],
        },
        work,
        schema,
      ),
    ).toEqual([]);
  });

  it('separates a nesting hop from a join hop', () => {
    expect(resolvePath(work, ['creator'], schema)).toEqual({
      leafType: creatorEdge,
      joinPath: [],
      nestedPath: ['creator'],
    });
  });

  it('reports a hop that walks into nothing, apart from a failed join', () => {
    // “This field is not nested” and “this field is not joinable” send an
    // author to different fixes, so they are different reasons. A joinable
    // name here would land the same way: there is no collection to address
    // from inside an array element.
    expect(resolvePath(work, ['creator', 'role'], schema)).toBe(
      'unknown-nesting',
    );
  });

  it('rejects a field the reference type does not declare', () => {
    expect(
      validateQuery(
        {
          ...base,
          where: [{ or: [{ on: ['creator'], field: 'nope', in: ['x'] }] }],
        },
        work,
        schema,
      ),
    ).toEqual([
      { part: 'where', field: 'creator.nope', reason: 'unknown-field' },
    ]);
  });

  it('descends an inline level in a `resolve` projection', () => {
    // A nested level fetches nothing – its entries are already in the hit – so
    // it is valid wherever they exist, and what it is FOR is the lookup below.
    expect(
      validateQuery(
        {
          ...base,
          resolve: { creator: { resolve: { creator: { fields: ['label'] } } } },
        },
        work,
        schema,
      ),
    ).toEqual([]);
  });

  it('reports an unresolvable level below a nested one', () => {
    expect(
      validateQuery(
        { ...base, resolve: { creator: { resolve: { role: {} } } } },
        work,
        schema,
      ),
    ).toEqual([{ part: 'resolve', field: 'role', reason: 'not-resolvable' }]);
  });

  it('refuses `id` on a nested hop, which addresses no document', () => {
    // An entry is read, not addressed: it has no document key, and the `id` a
    // local lookup stores is the ENDPOINT’s. Accepted, this would compile to
    // the ROOT document’s `id` and silently answer a different question.
    expect(
      validateQuery(
        {
          ...base,
          where: [{ or: [{ on: ['creator'], field: 'id', in: ['x'] }] }],
        },
        work,
        schema,
      ),
    ).toEqual([
      { part: 'where', field: 'creator.id', reason: 'unknown-nesting' },
    ]);
  });

  it('holds a nested field to its own filterability', () => {
    // The edge’s endpoint reference is `output` but not `filterable`, so it is
    // not addressable in `where`. Nesting grants no Role by itself.
    expect(
      validateQuery(
        {
          ...base,
          where: [{ or: [{ on: ['creator'], field: 'creator', in: ['x'] }] }],
        },
        work,
        schema,
      ),
    ).toEqual([
      { part: 'where', field: 'creator.creator', reason: 'not-filterable' },
    ]);
  });
});

describe('welding conditions to one entry', () => {
  const base: SearchQuery = {
    where: [],
    orderBy: [],
    limit: 10,
    offset: 0,
    facets: [],
    locale: 'nl',
  };
  const welded = (entry: readonly { field: string; in: string[] }[]) => ({
    ...base,
    where: [{ or: [{ field: 'creator', entry }] }],
  });

  it('accepts conditions on the fields of the edge’s own type', () => {
    expect(
      validateQuery(welded([{ field: 'role', in: ['etser'] }]), work, schema),
    ).toEqual([]);
  });

  it('holds a welded condition to the same rules as any other', () => {
    // No weaker validator for the inside of an edge: an unknown field is an
    // unknown field, reported under the path a consumer wrote.
    expect(
      validateQuery(welded([{ field: 'nope', in: ['x'] }]), work, schema),
    ).toEqual([
      { part: 'where', field: 'creator.nope', reason: 'unknown-field' },
    ]);
  });

  it('refuses to weld onto a field the type does not declare', () => {
    expect(
      validateQuery(
        { ...base, where: [{ or: [{ field: 'nope', entry: [] }] }] },
        work,
        schema,
      ),
    ).toEqual([{ part: 'where', field: 'nope', reason: 'not-weldable' }]);
  });

  it('refuses to weld onto a field that has no entries', () => {
    const flat = defineSearchType({
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
          ref: { strategy: 'lookup', target: 'Person' },
        },
      ],
    });

    expect(
      validateQuery(
        welded([{ field: 'role', in: ['etser'] }]),
        flat,
        searchSchema(flat, person),
      ),
    ).toEqual([{ part: 'where', field: 'creator', reason: 'not-weldable' }]);
  });
});

describe('nesting is where a node is projected, not what type it is', () => {
  // A Root Type reached by a `local` lookup is nested exactly as a Reference
  // Type is – it just happens to have a collection of its own elsewhere. Its
  // companions must therefore be written under the nested rule too. Deciding
  // that from the TYPE rather than from the projection context reads a
  // locally-nested root as a root, and the arity it writes then disagrees with
  // the one the collection declares: the import fails for every such document.
  const inner = defineSearchType({
    name: 'Membership',
    fields: [
      {
        name: 'org',
        kind: 'reference',
        path: `${SCHEMA_ORG}memberOf`,
        output: true,
        ref: { strategy: 'lookup', target: 'Person' },
      },
    ],
  });
  const nestedRoot = defineSearchType({
    name: 'Person',
    class: `${SCHEMA_ORG}Person`,
    key: { field: 'sameAs' },
    fields: [
      {
        name: 'label',
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
        name: 'affiliation',
        kind: 'reference',
        path: `${SCHEMA_ORG}affiliation`,
        output: true,
        filterable: true,
        ref: { strategy: 'inline', typeName: 'Membership', identity: 'org' },
      },
    ],
  });
  const work = defineSearchType({
    name: 'Work',
    class: `${SCHEMA_ORG}CreativeWork`,
    fields: [
      {
        name: 'creator',
        kind: 'reference',
        path: `${SCHEMA_ORG}creator`,
        output: true,
        ref: { strategy: 'lookup', target: 'Person', local: true },
      },
    ],
  });

  it('keeps every id where only facetable earned the companion', () => {
    // An identity is earned by `filterable` OR `facetable`, and fan-out splits
    // weldable leaves only. A facetable-only companion is therefore never
    // split, so narrowing it to one id would drop the rest – silently, since
    // the collection declares it a list.
    const facetedRoot = defineSearchType({
      name: 'Person',
      class: `${SCHEMA_ORG}Person`,
      fields: [
        {
          name: 'label',
          kind: 'text',
          path: `${SCHEMA_ORG}name`,
          locales: ['und'],
          output: true,
          searchable: { weight: 1 },
        },
        {
          name: 'affiliation',
          kind: 'reference',
          path: `${SCHEMA_ORG}affiliation`,
          array: true,
          output: true,
          facetable: true,
          ref: { strategy: 'inline', typeName: 'Membership', identity: 'org' },
        },
      ],
    });
    const work = defineSearchType({
      name: 'Work',
      class: `${SCHEMA_ORG}CreativeWork`,
      fields: [
        {
          name: 'creator',
          kind: 'reference',
          path: `${SCHEMA_ORG}creator`,
          output: true,
          ref: { strategy: 'lookup', target: 'Person', local: true },
        },
      ],
    });
    const node = {
      '@id': 'https://ex/work/13',
      [workKey('creator')]: [
        {
          '@id': 'https://p/1',
          [alias('Person', 'affiliation')]: [
            { [alias('Membership', 'org')]: [{ '@id': 'https://o/1' }] },
            { [alias('Membership', 'org')]: [{ '@id': 'https://o/2' }] },
          ],
        },
      ],
    };
    const document = projectDocument(
      node,
      work,
      searchSchema(work, facetedRoot, inner),
    );
    const endpoint = document.creator as SearchDocument;

    expect(endpoint.affiliation_id).toEqual(['https://o/1', 'https://o/2']);
  });

  it('writes a single-valued companion inside a locally-nested root type', () => {
    const node = {
      '@id': 'https://ex/work/10',
      [workKey('creator')]: [
        {
          '@id': 'https://p/1',
          [personKey('sameAs')]: [{ '@id': RKD }],
          [alias('Person', 'affiliation')]: [
            { [alias('Membership', 'org')]: [{ '@id': 'https://o/1' }] },
          ],
        },
      ],
    };
    const document = projectDocument(
      node,
      work,
      searchSchema(work, nestedRoot, inner),
    );
    const endpoint = document.creator as SearchDocument;

    // A single value, matching what the collection declares for this path -
    // not the one-element list a root-level companion would carry.
    expect(endpoint.affiliation_id).toBe('https://o/1');
  });
});

describe('a local lookup at the root', () => {
  it('harvests every endpoint into the flat companion', () => {
    // A top-level companion stands for the whole DOCUMENT rather than for one
    // entry, so nothing welds it and an `array` reference's companion holds
    // every id its endpoints carry – unchanged by the nested rule (ADR 26).
    const rootLookup = defineSearchType({
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
          ref: { strategy: 'lookup', target: 'Person', local: true },
        },
      ],
    });
    const twoEndpoints = {
      '@id': 'https://ex/work/8',
      [workKey('creator')]: [
        { '@id': 'https://a/1', [personKey('sameAs')]: [{ '@id': RKD }] },
        { '@id': 'https://a/2' },
      ],
    };
    const document = projectDocument(
      twoEndpoints,
      rootLookup,
      searchSchema(rootLookup, person),
    );

    expect(document.creator_id).toEqual([RKD, 'https://a/2']);
  });
});

describe('the identity companion of a local lookup', () => {
  // Its own id is a level deeper than a condition can be welded to, so
  // `filterable` fans it out as a leaf beside the stored object.
  const filterableEdge = defineSearchType({
    name: 'CreatorEdge',
    fields: [
      {
        name: 'role',
        kind: 'keyword',
        path: `${SCHEMA_ORG}name`,
        output: true,
        filterable: true,
      },
      {
        name: 'creator',
        kind: 'reference',
        path: `${SCHEMA_ORG}creator`,
        output: true,
        filterable: true,
        ref: { strategy: 'lookup', target: 'Person', local: true },
      },
    ],
  });

  it('is written beside the object it identifies', () => {
    const document = projectDocument(
      node,
      work,
      searchSchema(work, person, filterableEdge),
    );
    const [identified] = document.creator as readonly SearchDocument[];

    expect(identified.creator_id).toBe(RKD);
    expect((identified.creator as SearchDocument).id).toBe(RKD);
  });

  it('fans a multi-valued endpoint out into one entry per endpoint', () => {
    // The endpoint is what a weld names, so it is single-valued per entry: an
    // edge the graph gave two endpoints is two entries, not one entry holding
    // both. One entry holding both stands for either pairing and answers the
    // weld with neither (ADR 26).
    const jointEdge = defineSearchType({
      name: 'CreatorEdge',
      fields: [
        {
          name: 'creator',
          kind: 'reference',
          path: `${SCHEMA_ORG}creator`,
          output: true,
          filterable: true,
          ref: { strategy: 'lookup', target: 'Person', local: true },
        },
      ],
    });
    const twoEndpoints = {
      '@id': 'https://ex/work/5',
      [workKey('creator')]: [
        {
          [edgeKey('creator')]: [
            { '@id': 'https://a/1', [personKey('sameAs')]: [{ '@id': RKD }] },
            { '@id': 'https://a/2' },
          ],
        },
      ],
    };
    const document = projectDocument(
      twoEndpoints,
      work,
      searchSchema(work, person, jointEdge),
    );
    const entries = document.creator as readonly SearchDocument[];

    expect(entries).toHaveLength(2);
    expect(entries.map((entry) => entry.creator_id)).toEqual([
      RKD,
      'https://a/2',
    ]);
  });

  it('is absent where the endpoint is not identified', () => {
    const document = projectDocument(
      node,
      work,
      searchSchema(work, person, filterableEdge),
    );
    const [, unidentified] = document.creator as readonly SearchDocument[];

    expect(unidentified).not.toHaveProperty('creator_id');
  });
});

describe('two references nesting one edge type', () => {
  it('must agree about declaring an identity', () => {
    // One reference type yields ONE filter type. Left to disagree, whichever
    // field built it decides: the identity-bearing one silently loses its id
    // filter, or the other gains one that filters a nested object.
    const disagreeing = defineSearchType({
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
          ref: {
            strategy: 'inline',
            typeName: 'CreatorEdge',
            identity: 'creator',
          },
        },
        {
          name: 'contributor',
          kind: 'reference',
          path: `${SCHEMA_ORG}contributor`,
          array: true,
          output: true,
          ref: { strategy: 'inline', typeName: 'CreatorEdge' },
        },
      ],
    });

    expect(() => searchSchema(disagreeing, person, creatorEdge)).toThrow(
      /disagree about “identity”/,
    );
  });

  it('accepts two references that agree', () => {
    // The ordinary case: one edge type reached by two properties, each
    // declaring the identity it filters through.
    const agreeing = defineSearchType({
      name: 'Work',
      class: `${SCHEMA_ORG}CreativeWork`,
      fields: (['creator', 'contributor'] as const).map((name) => ({
        name,
        kind: 'reference' as const,
        path: `${SCHEMA_ORG}${name}`,
        array: true,
        output: true,
        filterable: true,
        ref: {
          strategy: 'inline' as const,
          typeName: 'CreatorEdge',
          identity: 'creator',
        },
      })),
    });

    expect(() => searchSchema(agreeing, person, creatorEdge)).not.toThrow();
  });

  it('names the identity-bearing field first, whichever came first', () => {
    // The message has to read the same either way round, or it sends an author
    // to the wrong declaration.
    const reversed = defineSearchType({
      name: 'Work',
      class: `${SCHEMA_ORG}CreativeWork`,
      fields: [
        {
          name: 'contributor',
          kind: 'reference',
          path: `${SCHEMA_ORG}contributor`,
          array: true,
          output: true,
          ref: { strategy: 'inline', typeName: 'CreatorEdge' },
        },
        {
          name: 'creator',
          kind: 'reference',
          path: `${SCHEMA_ORG}creator`,
          array: true,
          output: true,
          filterable: true,
          ref: {
            strategy: 'inline',
            typeName: 'CreatorEdge',
            identity: 'creator',
          },
        },
      ],
    });

    expect(() => searchSchema(reversed, person, creatorEdge)).toThrow(
      /“Work.creator” and “Work.contributor”/,
    );
  });
});

describe('a nested field cannot join out of its entry', () => {
  it('refuses joinable on a nested lookup', () => {
    // A join addresses another COLLECTION, and there is none to address from
    // inside an entry. Unrefused, the join graph builds no edge, the
    // collection emits no engine reference, and the criterion degrades to a
    // vacuous `in: []` – which matches everything.
    const joiningEdge = defineSearchType({
      name: 'CreatorEdge',
      fields: [
        {
          name: 'creator',
          kind: 'reference',
          path: `${SCHEMA_ORG}creator`,
          output: true,
          filterable: true,
          joinable: true,
          ref: { strategy: 'lookup', target: 'Person' },
        },
      ],
    });

    expect(() => searchSchema(work, person, joiningEdge)).toThrow(
      /declares “joinable”/,
    );
  });
});

describe('a local lookup is held to the Roles a nested object can serve', () => {
  const localReference = (extra: Record<string, unknown>) =>
    ({
      name: 'Local',
      class: `${SCHEMA_ORG}CreativeWork`,
      fields: [
        {
          name: 'creator',
          kind: 'reference',
          path: `${SCHEMA_ORG}creator`,
          output: true,
          ref: { strategy: 'lookup', target: 'Person', local: true },
          ...extra,
        },
      ],
    }) as never;

  it.each([
    ['searchable', { searchable: { weight: 1 } }],
    ['sortable', { sortable: true }],
    ['facetable', { facetable: true }],
  ])('rejects %s', (role, declaration) => {
    // It stores the referent’s own document, not an id. Unrefused, each fails
    // differently and late: a facet names a field the collection never
    // declares, a join emits an engine reference over a field holding objects.
    expect(() => searchSchema(localReference(declaration), person)).toThrow(
      new RegExp(`declares “${role}”`),
    );
  });

  it('rejects joinable, which the collection would silently not emit', () => {
    // `validateSearchType` refuses `joinable` on an INLINE reference, not on a
    // lookup – so without this the join graph builds the edge, the collection
    // builder takes the nesting branch and emits no engine reference, and the
    // join fails at query time against a field that was never declared.
    expect(() =>
      searchSchema(
        localReference({ joinable: true, labelSource: 'Person' }),
        person,
      ),
    ).toThrow(/declares “joinable”/);
  });

  it('accepts filterable, which earns it an identity companion', () => {
    // Its own id is a level deeper than a filter can be welded to – an engine
    // welds conditions on an entry's LEAF fields only – so `filterable` fans
    // the id out beside the object, exactly as an inline reference does.
    const filterable = localReference({ filterable: true }) as SearchType;
    const filterableSchema = searchSchema(filterable, person);

    expect(
      physicalFields(filterable.fields[0], filterableSchema).identity,
    ).toBe('creator_id');
  });

  it('accepts it as an output-only nesting', () => {
    expect(() => searchSchema(localReference({}), person)).not.toThrow();
  });
});

describe('declaring the companion', () => {
  const workWith = (ref: Record<string, unknown>) =>
    ({
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
          ref: { strategy: 'inline', typeName: 'CreatorEdge', ...ref },
        },
      ],
    }) as never;

  it('rejects an identity naming a field the edge does not declare', () => {
    expect(() =>
      searchSchema(workWith({ identity: 'nope' }), person, creatorEdge),
    ).toThrow(/names identity “nope”, which “CreatorEdge” does not declare/);
  });

  it('rejects an identity naming a field that names no target', () => {
    // A companion holds ids of documents in a collection, so the field it
    // harvests has to say which collection those ids belong to.
    expect(() =>
      searchSchema(workWith({ identity: 'role' }), person, creatorEdge),
    ).toThrow(/names no target/);
  });

  it('rejects filterable without an identity to filter through', () => {
    expect(() => searchSchema(workWith({}), person, creatorEdge)).toThrow(
      /without an “identity”/,
    );
  });

  it('rejects an identity declared inside a reference type', () => {
    // A companion is a flat field beside the reference, and only a Root Type
    // has somewhere flat to put one. Nested, the projection would write it into
    // each entry while the collection declared it nowhere – so a filter on it
    // would name a field the engine does not carry.
    const innerEdge = defineSearchType({
      name: 'InnerEdge',
      fields: [
        {
          name: 'creator',
          kind: 'reference',
          path: `${SCHEMA_ORG}creator`,
          output: true,
          ref: { strategy: 'lookup', target: 'Person' },
        },
      ],
    });
    const outerEdge = defineSearchType({
      name: 'OuterEdge',
      fields: [
        {
          name: 'inner',
          kind: 'reference',
          path: `${SCHEMA_ORG}creator`,
          array: true,
          output: true,
          filterable: true,
          ref: {
            strategy: 'inline',
            typeName: 'InnerEdge',
            identity: 'creator',
          },
        },
      ],
    });
    const nesting = defineSearchType({
      name: 'Work',
      class: `${SCHEMA_ORG}CreativeWork`,
      fields: [
        {
          name: 'credit',
          kind: 'reference',
          path: `${SCHEMA_ORG}creator`,
          array: true,
          output: true,
          ref: { strategy: 'inline', typeName: 'OuterEdge' },
        },
      ],
    });

    expect(() => searchSchema(nesting, person, outerEdge, innerEdge)).toThrow(
      /is a reference type: an identity companion is a flat field/,
    );
  });

  it('rejects an identity with no Role to read it', () => {
    const unread = {
      name: 'Work',
      class: `${SCHEMA_ORG}CreativeWork`,
      fields: [
        {
          name: 'creator',
          kind: 'reference',
          path: `${SCHEMA_ORG}creator`,
          array: true,
          output: true,
          ref: {
            strategy: 'inline',
            typeName: 'CreatorEdge',
            identity: 'creator',
          },
        },
      ],
    } as never;

    expect(() => searchSchema(unread, person, creatorEdge)).toThrow(
      /would be indexed and never read/,
    );
  });
});

describe('a facet policy over the companion', () => {
  it('narrows the companion the engine facets', () => {
    // The policy belongs to the endpoint’s type, and is inherited one level in
    // through the identity – so an excluded id is never seen by the engine.
    const alignedPerson = defineSearchType({
      ...person,
      facetKeys: {
        only: (id: string) => id.startsWith('https://rkd.example/'),
      },
    });
    const faceted = searchSchema(work, alignedPerson, creatorEdge);
    const document = projectDocument(node, work, faceted);

    expect(document.creator_id).toEqual([RKD]);
    expect(document.creator_id_facet).toEqual([RKD]);
  });

  it('writes no companion when no endpoint is identified', () => {
    const unidentified = {
      '@id': 'https://ex/work/2',
      [workKey('creator')]: [
        {
          [edgeKey('role')]: [{ '@value': 'auteur' }],
          [edgeKey('creator')]: [
            { [personKey('label')]: [{ '@value': 'Jan Jansen' }] },
          ],
        },
      ],
    };
    const document = projectDocument(unidentified, work, schema);

    expect(document.creator).toHaveLength(1);
    expect(document).not.toHaveProperty('creator_id');
  });
});

describe('an edge whose endpoint is stored as a bare id', () => {
  // `local` is opt-in: without it the endpoint is an id and nothing else. The
  // companion must harvest from that shape too, since which one a deployment
  // declares is about how much to display, not about identity.
  const idOnlyEdge = defineSearchType({
    name: 'CreatorEdge',
    fields: [
      {
        name: 'role',
        kind: 'keyword',
        path: `${SCHEMA_ORG}name`,
        output: true,
      },
      {
        name: 'creator',
        kind: 'reference',
        path: `${SCHEMA_ORG}creator`,
        output: true,
        ref: { strategy: 'lookup', target: 'Person' },
      },
    ],
  });
  const idOnlySchema = searchSchema(work, person, idOnlyEdge);

  it('harvests the id the entry stores directly', () => {
    const document = projectDocument(node, work, idOnlySchema);
    const entries = document.creator as readonly SearchDocument[];

    expect(entries[0].creator).toBe(RKD);
    expect(document.creator_id).toEqual([RKD]);
  });

  it('still frames the hop its target’s key is read from', () => {
    // Even with nothing of the endpoint displayed, the key that identifies it
    // is on the endpoint’s own node – so the frame has to reach it, or every
    // id stored is the publisher’s and matches nothing.
    expect(inlineFramingDepth(idOnlySchema, work)).toBe(2);
  });
});

describe('the label target a facet reads', () => {
  it('is the identity companion’s target, one level in', () => {
    // An inline reference names no label source of its own, so reading only
    // its own declaration would leave its facet buckets unlabelled.
    expect(labelTargetNameOf(work.fields[0], schema)).toBe('Person');
  });

  it('is nothing for a field that references nothing', () => {
    expect(labelTargetNameOf(creatorEdge.fields[0], schema)).toBeUndefined();
  });

  it('is nothing against a schema that does not declare the edge’s type', () => {
    // A type read against a FOREIGN schema resolves no reference type, so it
    // contributes nothing rather than resolving to the wrong one – the same
    // reading every schema-less path in the projection makes.
    const foreign = searchSchema(person);

    expect(labelTargetNameOf(work.fields[0], foreign)).toBeUndefined();
  });
});

describe('an edge whose identity holds several endpoints', () => {
  it('harvests every id the entry stores', () => {
    // A multi-valued nested reference: the entry holds a list, so the
    // companion holds all of it rather than only the first.
    const multiEdge = defineSearchType({
      name: 'CreatorEdge',
      fields: [
        {
          name: 'creator',
          kind: 'reference',
          path: `${SCHEMA_ORG}creator`,
          array: true,
          output: true,
          ref: { strategy: 'lookup', target: 'Person' },
        },
      ],
    });
    const multiSchema = searchSchema(work, person, multiEdge);
    const twoEndpoints = {
      '@id': 'https://ex/work/3',
      [workKey('creator')]: [
        {
          [edgeKey('creator')]: [
            { '@id': 'https://a/1', [personKey('sameAs')]: [{ '@id': RKD }] },
            { '@id': 'https://a/2' },
          ],
        },
      ],
    };
    const document = projectDocument(twoEndpoints, work, multiSchema);

    expect(document.creator_id).toEqual([RKD, 'https://a/2']);
  });
});

describe('framing depth in the awkward cases', () => {
  it('stops at a cycle rather than asking for unbounded depth', () => {
    // Inline cycles are rejected, but a `local` lookup can reach a Root Type
    // that reaches back – Work → Person → Work is a reasonable schema, and
    // nothing forbids it. The useful depth is the acyclic one.
    const cyclicPerson = defineSearchType({
      name: 'Person',
      class: `${SCHEMA_ORG}Person`,
      fields: [
        {
          name: 'label',
          kind: 'text',
          path: `${SCHEMA_ORG}name`,
          locales: ['und'],
          output: true,
          searchable: { weight: 1 },
        },
        {
          name: 'made',
          kind: 'reference',
          path: `${SCHEMA_ORG}makesOffer`,
          output: true,
          ref: { strategy: 'lookup', target: 'Work', local: true },
        },
      ],
    });
    const cyclicWork = defineSearchType({
      name: 'Work',
      class: `${SCHEMA_ORG}CreativeWork`,
      fields: [
        {
          name: 'label',
          kind: 'text',
          path: `${SCHEMA_ORG}name`,
          locales: ['und'],
          output: true,
          searchable: { weight: 1 },
        },
        {
          name: 'creator',
          kind: 'reference',
          path: `${SCHEMA_ORG}creator`,
          output: true,
          ref: { strategy: 'lookup', target: 'Person', local: true },
        },
      ],
    });
    const cyclic = searchSchema(cyclicWork, cyclicPerson);

    expect(inlineFramingDepth(cyclic, cyclicWork)).toBe(1);
  });

  it('frames the key hop the extraction falls back to at the cut', () => {
    // At the cut the local expansion stops and the extraction reads the key
    // instead – off a referent one hop further out than the expansion reached.
    // Counting the cut as “reach 0, nothing else” framed one hop short, and the
    // innermost referent stored a node IRI that keys nothing in its collection.
    const cutPerson = defineSearchType({
      name: 'Person',
      class: `${SCHEMA_ORG}Person`,
      labelField: 'label',
      fields: [
        {
          name: 'label',
          kind: 'text',
          path: `${SCHEMA_ORG}name`,
          locales: ['und'],
          output: true,
          searchable: { weight: 1 },
        },
        {
          // The field the cut falls on: `Work` is already on the path, so the
          // expansion stops and the key hop is what the extraction emits.
          name: 'made',
          kind: 'reference',
          path: `${SCHEMA_ORG}makesOffer`,
          output: true,
          ref: { strategy: 'lookup', target: 'Work', local: true },
        },
      ],
    });
    const keyedWork = defineSearchType({
      name: 'Work',
      class: `${SCHEMA_ORG}CreativeWork`,
      labelField: 'label',
      key: { field: '_sameAs' },
      fields: [
        {
          name: 'label',
          kind: 'text',
          path: `${SCHEMA_ORG}name`,
          locales: ['und'],
          output: true,
          searchable: { weight: 1 },
        },
        {
          name: '_sameAs',
          kind: 'reference',
          array: true,
          path: `${SCHEMA_ORG}sameAs`,
        },
        {
          name: 'creator',
          kind: 'reference',
          path: `${SCHEMA_ORG}creator`,
          output: true,
          ref: { strategy: 'lookup', target: 'Person', local: true },
        },
      ],
    });

    // work → creator → made → the key read off it: three hops, two intermediate
    // nodes.
    expect(
      inlineFramingDepth(searchSchema(keyedWork, cutPerson), keyedWork),
    ).toBe(2);
  });

  it('ignores a field with no path to traverse', () => {
    const derived = defineSearchType({
      name: 'Derived',
      class: `${SCHEMA_ORG}CreativeWork`,
      fields: [
        { name: 'count', kind: 'integer', output: true, derive: () => 1 },
      ],
    });

    expect(inlineFramingDepth(searchSchema(derived), derived)).toBe(1);
  });
});

describe('what the companion may harvest', () => {
  it('takes ids only from the entries the document stores', () => {
    // A single-valued reference keeps the first referent and drops the rest, so
    // an id harvested from a dropped one would match a filter whose hit then
    // shows no such entry.
    // Named `Work` deliberately: a framed node is keyed by the IR Alias of the
    // DECLARING type, so a differently-named fixture would read nothing and
    // pass for the wrong reason.
    const single = defineSearchType({
      name: 'Work',
      class: `${SCHEMA_ORG}CreativeWork`,
      fields: [
        {
          name: 'creator',
          kind: 'reference',
          path: `${SCHEMA_ORG}creator`,
          output: true,
          filterable: true,
          ref: {
            strategy: 'inline',
            typeName: 'CreatorEdge',
            identity: 'creator',
          },
        },
      ],
    });
    const document = projectDocument(
      node,
      single,
      searchSchema(single, person, creatorEdge),
    );

    expect(document.creator).not.toBeInstanceOf(Array);
    expect(document.creator_id).toEqual([RKD]);
  });
});
