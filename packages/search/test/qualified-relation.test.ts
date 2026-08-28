import { describe, expect, it } from 'vitest';
import { projectDocument, type SearchDocument } from '../src/project.js';
import {
  defineSearchType,
  inlineFramingDepth,
  labelTargetNameOf,
  searchSchema,
} from '../src/schema.js';
import { resolvePath, validateQuery, type SearchQuery } from '../src/query.js';

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

  it('rejects filterable, pointing at the companion instead', () => {
    expect(() =>
      searchSchema(localReference({ filterable: true }), person),
    ).toThrow(/identity companion/);
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
