import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Dataset, Distribution } from '@lde/dataset';
import type { DatasetWriter } from '@lde/pipeline';
import { defineSearchType, searchSchema } from '@lde/search';
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
      labelSource: 'Person',
      facetable: true,
      output: true,
      ref: { typeName: 'Person', strategy: 'labelOnly' },
    },
  ],
});

const schema = searchSchema(creativeWork, person);

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

  async function runStage(): Promise<TypedSearchDocument[]> {
    // No `readers`: the stage defaults to the generated Extraction CONSTRUCT,
    // proving the schema-derived reader and the projection agree end to end
    // against a real SPARQL engine, over roots selected by `selectByClass`.
    const [stage] = searchStages({
      schema,
      types: [
        {
          searchType: creativeWork,
          rootVariable: 'root',
          itemSelector: selectByClass(creativeWork),
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
    expect(first.creator).toEqual(['https://ex/p/1']);

    // A root with only a name still projects, with the optional fields absent.
    const second = byId['https://ex/cw/2'];
    expect(second.name_nl).toBe('De nachtwacht');
    expect(second).not.toHaveProperty('creator');
    expect(second).not.toHaveProperty('description_nl');
  });
});
