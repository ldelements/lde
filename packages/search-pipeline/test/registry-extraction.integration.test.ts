import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Dataset, Distribution } from '@lde/dataset';
import type { DatasetWriter } from '@lde/pipeline';
import { defineSearchType, searchSchema } from '@lde/search';
import {
  startSparqlEndpoint,
  teardownSparqlEndpoint,
} from '@lde/local-sparql-endpoint';
import {
  registrySource,
  searchStages,
  selectByClass,
} from '../src/search-stages.js';
import type { TypedSearchDocument } from '../src/typed-search-document.js';

const DCAT = 'http://www.w3.org/ns/dcat#';
const DCTERMS = 'http://purl.org/dc/terms/';
const FOAF = 'http://xmlns.com/foaf/0.1/';

// A register-shaped schema: the dataset description itself, plus the publisher
// it points at as a root type of its own – the only way a reference’s labels
// can be resolved, since a label source must be a Root Type with a collection.
const publisher = defineSearchType({
  name: 'Publisher',
  class: `${FOAF}Organization`,
  fields: [
    {
      name: 'label',
      kind: 'text',
      path: `<${FOAF}name>`,
      locales: ['nl', 'en', 'und'],
      output: true,
      searchable: { weight: 5 },
    },
  ],
});

const datasetType = defineSearchType({
  name: 'Dataset',
  class: `${DCAT}Dataset`,
  fields: [
    {
      name: 'label',
      kind: 'text',
      path: `<${DCTERMS}title>`,
      locales: ['nl', 'en', 'und'],
      output: true,
      searchable: { weight: 5 },
      sortable: true,
    },
    {
      name: 'description',
      kind: 'text',
      path: `<${DCTERMS}description>`,
      locales: ['nl', 'en', 'und'],
      output: true,
      searchable: { weight: 2 },
    },
    {
      name: 'publisher',
      kind: 'reference',
      path: `<${DCTERMS}publisher>`,
      array: true,
      labelSource: 'Publisher',
      output: true,
      filterable: true,
      facetable: true,
      ref: { typeName: 'Publisher', strategy: 'labelOnly' },
    },
    {
      name: 'license',
      kind: 'reference',
      path: `<${DCTERMS}license>`,
      array: true,
      output: true,
      filterable: true,
      facetable: true,
      ref: { typeName: 'License', strategy: 'idOnly' },
    },
    {
      name: 'landingPage',
      kind: 'reference',
      path: `<${DCAT}landingPage>`,
      output: true,
      ref: { typeName: 'WebPage', strategy: 'idOnly' },
    },
  ],
});

const schema = searchSchema(datasetType, publisher);

describe('registry-sourced extraction: scoped to the dataset’s own graph', () => {
  const port = 3009;
  const registryEndpoint = new URL(`http://localhost:${port}/sparql`);
  // The dataset’s own distribution is deliberately somewhere else entirely: a
  // registry-sourced stage must never read it, so a stage that ignored
  // `sourceFor` would fail to connect rather than quietly pass.
  const distribution = Distribution.sparql(
    new URL('http://localhost:9/unreachable'),
  );

  beforeAll(async () => {
    const fixture = fileURLToPath(
      new URL('./fixtures/register-sample.trig', import.meta.url),
    );
    await startSparqlEndpoint(port, fixture);
  }, 60_000);

  afterAll(async () => {
    await teardownSparqlEndpoint();
  });

  /** Run both registry-sourced stages over one dataset, as a pipeline pass
   *  would, and collect what the writer receives. */
  async function runStages(datasetIri: string): Promise<TypedSearchDocument[]> {
    const dataset = new Dataset({
      iri: new URL(datasetIri),
      distributions: [distribution],
    });
    // No `readers`: each stage defaults to the generated Extraction CONSTRUCT,
    // so this proves the generator, the graph scoping, the framing and the
    // projection agree end to end against a real SPARQL engine.
    const stages = searchStages({
      schema,
      types: [datasetType, publisher].map((searchType) => ({
        searchType,
        rootVariable: 'root',
        itemSelector: selectByClass(searchType),
        sourceFor: registrySource(registryEndpoint),
      })),
    });
    const received: TypedSearchDocument[] = [];
    const writer: DatasetWriter<TypedSearchDocument> = {
      write: async (_dataset, items) => {
        for await (const item of items) {
          received.push(item);
        }
      },
    };
    for (const stage of stages) {
      await stage.run(dataset, distribution, writer);
    }
    return received;
  }

  it('projects the registration in hand, publisher hop included', async () => {
    const received = await runStages('https://ex/dataset/a');
    const byType = (name: string) =>
      received
        .filter((item) => item.searchType.name === name)
        .map((item) => item.document);

    expect(byType('Dataset')).toEqual([
      {
        id: 'https://ex/dataset/a',
        label_nl: 'Vaandels van Limburg',
        label_en: 'Banners of Limburg',
        label_search_nl: 'vaandels van limburg',
        label_sort_nl: 'vaandels van limburg',
        label_search_en: 'banners of limburg',
        label_sort_en: 'banners of limburg',
        description_nl: 'Een dataset over vaandels.',
        description_search_nl: 'een dataset over vaandels.',
        publisher: ['https://ex/org/trace'],
        license: ['https://creativecommons.org/licenses/by-nc-nd/4.0/'],
        landingPage: 'https://ex/a/',
      },
    ]);

    // The publisher is described inside the dataset’s own graph, so its root
    // type is selected and projected from the same scoped source – no second
    // endpoint, no unscoped query across the whole register.
    expect(byType('Publisher')).toEqual([
      {
        id: 'https://ex/org/trace',
        label_nl: 'Tracé - Limburgs Samenlevingsarchief',
        label_search_nl: 'trace - limburgs samenlevingsarchief',
      },
    ]);
  });

  it('never reaches another registration’s graph', async () => {
    // The register holds every registration; without the graph scoping a
    // per-dataset pass would index the whole catalogue each time round. Asserted
    // together with what the pass *did* produce, so losing the scoping fails
    // here rather than passing vacuously on an empty result.
    const received = await runStages('https://ex/dataset/a');
    const ids = received.map((item) => item.document.id);

    expect(ids).toContain('https://ex/dataset/a');
    expect(ids).toContain('https://ex/org/trace');
    expect(ids).not.toContain('https://ex/dataset/b');
    expect(ids).not.toContain('https://ex/org/other');
  });

  it('scopes to whichever dataset is in hand', async () => {
    const received = await runStages('https://ex/dataset/b');
    const ids = received.map((item) => item.document.id);

    expect(ids).toContain('https://ex/dataset/b');
    expect(ids).toContain('https://ex/org/other');
    expect(ids).not.toContain('https://ex/dataset/a');
  });

  it('cannot select a registration that was never crawled', async () => {
    // `schema:Dataset` lives in the registrations graph, `dcat:Dataset` in the
    // crawled description – so selecting by the DCAT class inside the dataset’s
    // own graph structurally excludes the registration-only stubs, rather than
    // filtering them out afterwards. Paired with a crawled one, so an empty
    // result here means “excluded”, not “nothing works”.
    expect(await runStages('https://ex/dataset/uncrawled')).toEqual([]);
    expect(await runStages('https://ex/dataset/a')).not.toEqual([]);
  });
});
