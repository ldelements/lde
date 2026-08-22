import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Dataset, Distribution } from '@lde/dataset';
import type { DatasetWriter } from '@lde/pipeline';
import { defineSearchType, searchSchema, type RootType } from '@lde/search';
import {
  startSparqlEndpoint,
  teardownSparqlEndpoint,
} from '@lde/local-sparql-endpoint';
import { searchStages, selectByClass } from '../src/search-stages.js';
import type { TypedSearchDocument } from '../src/typed-search-document.js';

const SCHEMA = 'https://schema.org/';
const GEONAMES = 'https://sws.geonames.org/';
const GND = 'https://d-nb.info/gnd/';

/** The deployment’s one predicate: an IRI an authority can resolve. */
const isCovered = (iri: string) =>
  iri.startsWith(GEONAMES) || iri.startsWith(GND);

/** The deployment’s IRI normalisation, on the key field – so two publishers
 *  spelling one alignment differently produce one candidate. */
const normaliseIri = (iri: string) =>
  iri.replace(/^http:/, 'https:').replace(/\/$/, '');

const place = defineSearchType({
  name: 'Place',
  class: `${SCHEMA}Place`,
  labelField: 'name',
  // A preference order, not a filter: GeoNames first (for its coordinates),
  // then any other resolvable source; nothing matched keeps the publisher’s node.
  key: {
    field: '_sameAs',
    pick: (candidates) =>
      candidates.find((iri) => iri.startsWith(GEONAMES)) ??
      candidates.find(isCovered),
  },
  fields: [
    {
      name: 'name',
      kind: 'text',
      path: `<${SCHEMA}name>`,
      locales: ['und'],
      output: true,
      searchable: { weight: 3 },
    },
    {
      // Internal: read for the key, then pruned before the writer.
      name: '_sameAs',
      kind: 'reference',
      array: true,
      path: `<${SCHEMA}sameAs>`,
      transform: normaliseIri,
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
      locales: ['nl'],
      output: true,
      searchable: { weight: 5 },
    },
    {
      name: 'locationCreated',
      kind: 'reference',
      path: `<${SCHEMA}locationCreated>`,
      facetable: true,
      output: true,
      ref: { strategy: 'lookup', target: 'Place' },
    },
  ],
});

const schema = searchSchema(creativeWork, place);

describe('a root type keyed on a declared field, end to end', () => {
  const port = 3011;
  const distribution = Distribution.sparql(
    new URL(`http://localhost:${port}/sparql`),
  );
  const dataset = new Dataset({
    iri: new URL('http://example.org/dataset/keyed'),
    distributions: [distribution],
  });

  beforeAll(async () => {
    const fixture = fileURLToPath(
      new URL('./fixtures/keyed-places-sample.ttl', import.meta.url),
    );
    await startSparqlEndpoint(port, fixture);
  }, 60_000);

  afterAll(async () => {
    await teardownSparqlEndpoint();
  });

  /** Run the generated Extraction CONSTRUCT for one type against the endpoint,
   *  over roots selected by class, and collect the projected documents. */
  async function project(
    searchType: RootType,
  ): Promise<Record<string, unknown>[]> {
    const [stage] = searchStages({
      schema,
      types: [
        {
          searchType,
          rootVariable: 'root',
          itemSelector: selectByClass(searchType),
        },
      ],
    });
    const documents: Record<string, unknown>[] = [];
    const writer: DatasetWriter<TypedSearchDocument> = {
      write: async (_dataset, items) => {
        for await (const item of items) {
          documents.push(item.document);
        }
      },
    };
    await stage.run(dataset, distribution, writer);
    return documents;
  }

  it('keys each place on its alignment, falling back to the publisher’s node', async () => {
    const documents = await project(place);

    expect(documents.map((document) => document.id).sort()).toEqual(
      [
        // Unaligned, and aligned into a source `pick` declines: their own nodes.
        'https://a/place/buurtschap',
        'https://a/place/kessel',
        // Two alignments, `pick` preferring the GeoNames one – the second
        // candidate once they are sorted.
        `${GEONAMES}2748812`,
        // Two publishers’ nodes for one place, spelled `http://…/` and
        // `https://…`: ONE key, because the key field’s transform ran first.
        `${GEONAMES}2745707`,
        `${GEONAMES}2745707`,
      ].sort(),
    );

    // The key field is internal – it keys the document and never reaches the
    // writer.
    for (const document of documents) {
      expect(document).not.toHaveProperty('_sameAs');
    }
  });

  it('stores each work’s place reference under that place’s key', async () => {
    const byName = Object.fromEntries(
      (await project(creativeWork)).map((document) => [
        document.name_nl,
        document,
      ]),
    );

    // Aligned referents: the work points at the place’s document, not at the
    // publisher’s node – which is what makes the lookup resolve.
    expect(byName['Werk 1'].locationCreated).toBe(`${GEONAMES}2745707`);
    expect(byName['Werk 3'].locationCreated).toBe(`${GEONAMES}2748812`);
    // Unaligned and declined referents keep their node IRI, and still resolve:
    // that is the id their own document is written under.
    expect(byName['Werk 2'].locationCreated).toBe('https://a/place/kessel');
    expect(byName['Werk 4'].locationCreated).toBe('https://a/place/buurtschap');
  });
});
