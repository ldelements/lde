import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Dataset, Distribution } from '@lde/dataset';
import type { DatasetWriter } from '@lde/pipeline';
import { defineSearchType, searchSchema } from '@lde/search';
import type { RootType, SearchSchema } from '@lde/search';
import {
  startSparqlEndpoint,
  teardownSparqlEndpoint,
} from '@lde/local-sparql-endpoint';
import { searchStages, selectByClass } from '../src/search-stages.js';
import type { TypedSearchDocument } from '../src/typed-search-document.js';

const SCHEMA = 'https://schema.org/';

// A Drapo-shaped schema (see fixtures/drapo-sample.ttl): CreativeWork with two
// localized text fields and a labelOnly creator reference; Person resolves the
// creator labels. Paths are single predicates in the reader-adapter grammar.
const person = defineSearchType({
  name: 'Person',
  class: `${SCHEMA}Person`,
  fields: [
    {
      name: 'label',
      kind: 'text',
      path: `<${SCHEMA}name>`,
      locales: ['und'],
      output: true,
      searchable: { weight: 3 },
    },
  ],
});

const creativeWork = defineSearchType({
  name: 'CreativeWork',
  class: `${SCHEMA}CreativeWork`,
  fields: [
    {
      name: 'name',
      kind: 'text',
      path: `<${SCHEMA}name>`,
      locales: ['nl', 'en'],
      output: true,
      searchable: { weight: 5 },
      sortable: true,
    },
    {
      name: 'description',
      kind: 'text',
      path: `<${SCHEMA}description>`,
      locales: ['nl'],
      output: true,
      searchable: { weight: 2 },
    },
    {
      name: 'creator',
      kind: 'reference',
      path: `<${SCHEMA}creator>`,

      facetable: true,
      output: true,
      ref: { strategy: 'lookup', target: 'Person' },
    },
  ],
});

const schema = searchSchema(creativeWork, person);

// The qualified-relation shape over the same fixture: a `VisualArtwork` whose
// `creator` is a Role carrying its own value and resolving an agent. Its own
// schema, since its `Agent` names the same source class `person` does.
const agent = defineSearchType({
  name: 'Agent',
  class: `${SCHEMA}Person`,
  labelField: 'name',
  fields: [
    {
      name: 'name',
      kind: 'text',
      path: `<${SCHEMA}name>`,
      locales: ['nl', 'und'],
      output: true,
      searchable: { weight: 5 },
    },
  ],
});

const creatorRole = defineSearchType({
  name: 'CreatorRole',
  fields: [
    {
      // Single-valued: a leaf a weld can name states one value per entry, and
      // an edge the graph gave several roles fans out (ADR 26).
      name: 'role',
      kind: 'keyword',
      output: true,
      filterable: true,
      path: `<${SCHEMA}roleName>`,
    },
    {
      name: 'agent',
      kind: 'reference',
      output: true,
      filterable: true,
      path: `<${SCHEMA}creator>`,
      ref: { strategy: 'lookup', target: 'Agent', local: true },
    },
  ],
});

const visualArtwork = defineSearchType({
  name: 'VisualArtwork',
  class: `${SCHEMA}VisualArtwork`,
  fields: [
    {
      name: 'name',
      kind: 'text',
      path: `<${SCHEMA}name>`,
      locales: ['nl'],
      output: true,
      searchable: { weight: 5 },
    },
    {
      name: 'creator',
      kind: 'reference',
      array: true,
      output: true,
      facetable: true,
      path: `<${SCHEMA}creator>`,
      ref: { strategy: 'inline', typeName: 'CreatorRole', identity: 'agent' },
    },
  ],
});

const roleSchema = searchSchema(visualArtwork, agent, creatorRole);

// The same relation where the publisher may leave the Role out, over a
// `Photograph`: the agent is a person or an organization, and an organization
// is keyed on its authority record – so a flat agent is only found if its type
// and alignment are read where the work points, not one hop past a Role.
const photoPerson = defineSearchType({
  name: 'PhotoPerson',
  class: `${SCHEMA}Person`,
  labelField: 'name',
  fields: [
    {
      name: 'name',
      kind: 'text',
      path: `<${SCHEMA}name>`,
      locales: ['und'],
      output: true,
      searchable: { weight: 1 },
    },
  ],
});

const photoOrganization = defineSearchType({
  name: 'PhotoOrganization',
  class: `${SCHEMA}Organization`,
  labelField: 'name',
  key: { field: 'sameAs' },
  fields: [
    {
      name: 'name',
      kind: 'text',
      path: `<${SCHEMA}name>`,
      locales: ['und'],
      output: true,
      searchable: { weight: 1 },
    },
    {
      name: 'sameAs',
      kind: 'reference',
      array: true,
      path: `<${SCHEMA}sameAs>`,
    },
  ],
});

const contributorRole = defineSearchType({
  name: 'ContributorRole',
  edgeClass: `${SCHEMA}Role`,
  fields: [
    {
      name: 'role',
      kind: 'keyword',
      output: true,
      path: `<${SCHEMA}roleName>`,
    },
    {
      name: 'contributor',
      kind: 'reference',
      output: true,
      filterable: true,
      path: `<${SCHEMA}contributor>`,
      ref: {
        strategy: 'lookup',
        target: ['PhotoPerson', 'PhotoOrganization'],
        local: true,
      },
    },
  ],
});

const photograph = defineSearchType({
  name: 'Photograph',
  class: `${SCHEMA}Photograph`,
  fields: [
    {
      name: 'contributor',
      kind: 'reference',
      array: true,
      output: true,
      facetable: true,
      path: `<${SCHEMA}contributor>`,
      ref: {
        strategy: 'inline',
        typeName: 'ContributorRole',
        identity: 'contributor',
      },
    },
  ],
});

const optionalEdgeSchema = searchSchema(
  photograph,
  photoPerson,
  photoOrganization,
  contributorRole,
);

// A value the graph may state bare or on a node: a literal identifier lands in
// the PropertyValue’s `value`, beside the ones stated on a node.
const propertyValue = defineSearchType({
  name: 'PropertyValue',
  literalField: 'value',
  fields: [
    {
      name: 'value',
      kind: 'keyword',
      output: true,
      path: `<${SCHEMA}value>`,
    },
    {
      name: 'propertyID',
      kind: 'reference',
      output: true,
      path: `<${SCHEMA}propertyID>`,
      ref: { strategy: 'idOnly' },
    },
  ],
});

const sculpture = defineSearchType({
  name: 'Sculpture',
  class: `${SCHEMA}Sculpture`,
  fields: [
    {
      name: 'identifier',
      kind: 'reference',
      array: true,
      output: true,
      path: `<${SCHEMA}identifier>`,
      ref: { strategy: 'inline', typeName: 'PropertyValue' },
    },
  ],
});

const literalSchema = searchSchema(sculpture, propertyValue);

// A literal field with no path: filled from a literal only, its language tag
// kept, while a node fills the type’s other fields.
const size = defineSearchType({
  name: 'Size',
  literalField: 'statement',
  fields: [
    { name: 'statement', kind: 'text', locales: ['nl', 'und'], output: true },
    { name: 'value', kind: 'number', output: true, path: `<${SCHEMA}value>` },
  ],
});

const drawing = defineSearchType({
  name: 'Drawing',
  class: `${SCHEMA}Drawing`,
  fields: [
    {
      name: 'size',
      kind: 'reference',
      array: true,
      output: true,
      path: `<${SCHEMA}size>`,
      ref: { strategy: 'inline', typeName: 'Size' },
    },
  ],
});

const sizeSchema = searchSchema(drawing, size);

describe('extraction round-trip: generate → read → frame → project', () => {
  const port = 3007;
  const distribution = Distribution.sparql(
    new URL(`http://localhost:${port}/sparql`),
  );
  const dataset = new Dataset({
    iri: new URL('http://example.org/dataset/drapo'),
    distributions: [distribution],
  });

  beforeAll(async () => {
    // Absolute path so the endpoint finds the fixture regardless of the cwd the
    // runner spawns it from.
    const fixture = fileURLToPath(
      new URL('./fixtures/drapo-sample.ttl', import.meta.url),
    );
    await startSparqlEndpoint(port, fixture);
  }, 60_000);

  afterAll(async () => {
    await teardownSparqlEndpoint();
  });

  async function runStage(
    forSchema: SearchSchema = schema,
    searchType: RootType = creativeWork,
  ): Promise<TypedSearchDocument[]> {
    // No `readers`: the stage defaults to the generated Extraction CONSTRUCT,
    // proving the schema-derived reader and the projection agree end to end
    // against a real SPARQL engine, over roots selected by `selectByClass`.
    const [stage] = searchStages({
      schema: forSchema,
      types: [
        {
          searchType,
          rootVariable: 'root',
          itemSelector: selectByClass(searchType),
        },
      ],
    });
    const received: TypedSearchDocument[] = [];
    const writer: DatasetWriter<TypedSearchDocument> = {
      write: async (_dataset, items) => {
        for await (const item of items) {
          received.push(item);
        }
      },
    };
    await stage.run(dataset, distribution, writer);
    return received;
  }

  it('projects each selected CreativeWork root into its search document', async () => {
    const received = await runStage();

    for (const item of received) {
      expect(item.searchType).toBe(creativeWork);
    }
    const byId = Object.fromEntries(
      received.map((item) => [item.document.id, item.document]),
    );
    // Exactly the two IRI-rooted works: the fixture’s blank-node CreativeWork
    // is never selected as a root – a blank node has no stable document key.
    expect(Object.keys(byId).sort()).toEqual([
      'https://ex/cw/1',
      'https://ex/cw/2',
    ]);

    // The localized name flattened per locale, folded into the search field…
    const first = byId['https://ex/cw/1'];
    expect(first.name_nl).toBe('Het meisje met de parel');
    expect(first.name_en).toBe('Girl with a Pearl Earring');
    expect(first.name_search_nl).toBe('het meisje met de parel');
    expect(first.description_nl).toBe('Een schilderij van Johannes Vermeer.');
    // …and the labelOnly creator carried as its bare IRI (label resolved at
    // query time from the Person collection, not here).
    expect(first.creator).toBe('https://ex/p/1');

    // A root with only a name still projects, with the optional fields absent.
    const second = byId['https://ex/cw/2'];
    expect(second.name_nl).toBe('De nachtwacht');
    expect(second).not.toHaveProperty('creator');
    expect(second).not.toHaveProperty('description_nl');
  });

  it('reads a `local` lookup’s agent out of the graph, identified or not', async () => {
    const [item] = await runStage(roleSchema, visualArtwork);
    const entries = item?.document.creator as Record<string, unknown>[];

    const entryFor = (role: string) =>
      entries.find((entry) => (entry.role as string[]).includes(role));

    // An identified agent: the id the reference has always stored, and now the
    // name this document states about it, read off the referent one hop on.
    expect(entryFor('etser')?.agent).toEqual(
      expect.objectContaining({
        id: 'https://ex/p/1',
        name_und: 'Johannes Vermeer',
      }),
    );
    // An agent the graph named inline: an entry like any other, minus its id –
    // which is the whole reason `local` exists, and what a plain lookup loses.
    expect(entryFor('uitgever')?.agent).toEqual(
      expect.objectContaining({ name_nl: 'Onbekende drukker' }),
    );
    expect(entryFor('uitgever')?.agent).not.toHaveProperty('id');
    // The facet stays keyed on identity alone, so the inline agent buckets
    // under nothing rather than under a label.
    expect(entryFor('etser')?.agent_id).toBe('https://ex/p/1');
    expect(entryFor('uitgever')).not.toHaveProperty('agent_id');
    expect(item?.document).not.toHaveProperty('creator_id');
  });

  it('reads an agent stated without its Role, keyed like one stated in it', async () => {
    const [item] = await runStage(optionalEdgeSchema, photograph);
    const entries = item?.document.contributor as Record<string, unknown>[];

    expect(entries).toHaveLength(4);
    // A bare IRI the graph says nothing else about is still an endpoint, kept
    // by id – as it would be inside a Role.
    expect(entries).toContainEqual({
      contributor: expect.objectContaining({ id: 'https://ex/o/2' }),
      contributor_id: 'https://ex/o/2',
    });
    expect(entries).toContainEqual(
      expect.objectContaining({
        role: 'drukker',
        contributor: expect.objectContaining({
          id: 'https://ex/p/1',
          name_und: 'Johannes Vermeer',
        }),
      }),
    );
    // Stated flat, and re-keyed on its authority record: the type and the
    // alignment were read at the first hop, where the work points.
    const flat = entries.find(
      (entry) =>
        (entry.contributor as Record<string, unknown> | undefined)?.name_und ===
        'Société Céramique',
    );
    expect(flat?.contributor).toEqual(
      expect.objectContaining({
        id: 'https://rkd.example/104628',
        name_und: 'Société Céramique',
      }),
    );
    // A Role naming no agent stays an edge, not an agent called “fabrikant”.
    expect(entries).toContainEqual({ role: 'fabrikant' });
    expect(entries.map((entry) => entry.contributor_id)).toEqual(
      expect.arrayContaining(['https://ex/p/1', 'https://rkd.example/104628']),
    );
    expect(item?.document).not.toHaveProperty('contributor_id');
  });

  it('reads a value stated bare beside one stated on a node, as one list', async () => {
    const [item] = await runStage(literalSchema, sculpture);
    const entries = item?.document.identifier as Record<string, unknown>[];

    expect(entries).toHaveLength(2);
    expect(entries).toContainEqual({ value: 'G11125-19' });
    expect(entries).toContainEqual({
      value: '12042',
      propertyID: 'https://data.axiell.com/vocabulary#Priref',
    });
  });

  it('fills a literal field with no path from a literal only, tag kept', async () => {
    const [item] = await runStage(sizeSchema, drawing);
    const entries = item?.document.size as Record<string, unknown>[];

    expect(entries).toHaveLength(3);
    expect(entries).toContainEqual({
      statement_nl: '74 cm hoog bij 92 cm breed',
    });
    // An untagged literal lands under the reserved `und` locale.
    expect(entries).toContainEqual({ statement_und: 'groot' });
    expect(entries).toContainEqual({ value: 74 });
  });
});
