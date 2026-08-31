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
      name: 'role',
      kind: 'keyword',
      array: true,
      output: true,
      filterable: true,
      path: `<${SCHEMA}roleName>`,
    },
    {
      name: 'agent',
      kind: 'reference',
      array: true,
      output: true,
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
    expect(entryFor('etser')?.agent).toEqual([
      expect.objectContaining({
        id: 'https://ex/p/1',
        name_und: 'Johannes Vermeer',
      }),
    ]);
    // An agent the graph named inline: an entry like any other, minus its id –
    // which is the whole reason `local` exists, and what a plain lookup loses.
    expect(entryFor('uitgever')?.agent).toEqual([
      expect.objectContaining({ name_nl: 'Onbekende drukker' }),
    ]);
    expect(entryFor('uitgever')?.agent).not.toEqual([
      expect.objectContaining({ id: expect.anything() }),
    ]);
    // The facet stays keyed on identity alone, so the inline agent buckets
    // under nothing rather than under a label.
    expect(item?.document.creator_id).toEqual(['https://ex/p/1']);
  });
});
