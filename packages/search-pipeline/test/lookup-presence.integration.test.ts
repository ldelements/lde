import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Dataset, Distribution } from '@lde/dataset';
import type { QuadTransform, ReaderContext } from '@lde/pipeline';
import { defineSearchType, searchSchema } from '@lde/search';
import { irAlias } from '@lde/search/adapter';
import { DataFactory } from 'n3';
import {
  startSparqlEndpoint,
  teardownSparqlEndpoint,
} from '@lde/local-sparql-endpoint';
import { searchStages, selectByClass } from '../src/search-stages.js';

const SCHEMA = 'https://schema.org/';
const GEONAMES = 'https://sws.geonames.org/';

/**
 * A lookup’s presence leaf, counted at index time: the extraction reads the
 * leaf one hop from the root, the target type’s transform runs on the
 * referent in the batch, and the projection writes whether any referent holds
 * a value. A referent the graph names by IRI alone enters the transform all
 * the same – the type’s own, for a lookup into its own type – so a transform
 * describing a place from its key supplies its coordinates. A blank-node
 * referent is no id the lookup stores, so it does not count.
 */
describe('a lookup’s presence leaf, through its target’s transform', () => {
  const port = 3020;
  const distribution = Distribution.sparql(
    new URL(`http://localhost:${port}/sparql`),
  );
  const dataset = new Dataset({
    iri: new URL('http://example.org/dataset/lookup-presence'),
    distributions: [distribution],
  });

  const place = defineSearchType({
    name: 'Place',
    class: `${SCHEMA}Place`,
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
      {
        name: 'latitude',
        kind: 'number',
        path: `<${SCHEMA}latitude>`,
        output: true,
      },
    ],
  });
  const work = defineSearchType({
    name: 'Work',
    class: `${SCHEMA}CreativeWork`,
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
      {
        name: 'contentLocation',
        kind: 'reference',
        path: `<${SCHEMA}contentLocation>`,
        output: true,
        filterable: true,
        ref: {
          strategy: 'lookup',
          target: 'Place',
          presenceLeaves: ['latitude'],
        },
      },
    ],
  });
  const schema = searchSchema(work, place);

  // The deployment’s place transform: a GeoNames place is described from its
  // IRI, coordinates included – whatever else the batch says of it.
  const latitudeAlias = irAlias(place, place.fields[1]);
  const seen: string[] = [];
  const geonamesCoordinates: QuadTransform<ReaderContext> = async function* (
    quads,
  ) {
    const subjects = new Set<string>();
    for await (const quad of quads) {
      subjects.add(quad.subject.value);
      yield quad;
    }
    seen.push(...subjects);
    for (const subject of subjects) {
      if (subject.startsWith(GEONAMES)) {
        yield DataFactory.quad(
          DataFactory.namedNode(subject),
          DataFactory.namedNode(latitudeAlias),
          DataFactory.literal('51.37'),
        );
      }
    }
  };

  beforeAll(async () => {
    await startSparqlEndpoint(
      port,
      fileURLToPath(
        new URL('./fixtures/lookup-presence-sample.ttl', import.meta.url),
      ),
    );
  }, 60_000);

  afterAll(async () => {
    await teardownSparqlEndpoint();
  });

  async function project(withTransform: boolean, batchSize?: number) {
    const [stage] = searchStages({
      schema,
      types: [
        {
          searchType: work,
          rootVariable: 'root',
          itemSelector: selectByClass(work),
          ...(batchSize !== undefined && { batchSize }),
        },
        {
          searchType: place,
          rootVariable: 'root',
          itemSelector: selectByClass(place),
          ...(withTransform && { transform: [geonamesCoordinates] }),
        },
      ],
    });
    const documents = new Map<string, Record<string, unknown>>();
    await stage.run(dataset, distribution, {
      write: async (_dataset, items) => {
        for await (const item of items) {
          documents.set(String(item.document.name_und), item.document);
        }
      },
    });
    return documents;
  }

  it('counts a referent the transform describes from its IRI alone', async () => {
    const documents = await project(true);

    expect(documents.get('Geonames')?.contentLocation_latitude_exists).toBe(
      true,
    );
    expect(documents.get('Unknown')?.contentLocation_latitude_exists).toBe(
      false,
    );
    expect(documents.get('Stated')?.contentLocation_latitude_exists).toBe(true);
    expect(documents.get('Bare')?.contentLocation_latitude_exists).toBe(false);
    // Every referent entered the transform, the IRI-only ones included…
    expect(seen).toEqual(
      expect.arrayContaining([
        'https://sws.geonames.org/2745707',
        'https://a/place/unknown',
        'https://a/place/stated',
      ]),
    );
    // …and what seeded them is not kept: the work still names one place.
    expect(documents.get('Geonames')?.contentLocation).toBe(
      'https://sws.geonames.org/2745707',
    );
  });

  it('reads the leaf the work’s own graph states, without a transform', async () => {
    const documents = await project(false);

    expect(documents.get('Geonames')?.contentLocation_latitude_exists).toBe(
      false,
    );
    expect(documents.get('Stated')?.contentLocation_latitude_exists).toBe(true);
  });

  it('counts per batch, a batch whose referents are all named by IRI alone included', async () => {
    const documents = await project(true, 1);

    expect(documents.get('Geonames')?.contentLocation_latitude_exists).toBe(
      true,
    );
    expect(documents.get('Unknown')?.contentLocation_latitude_exists).toBe(
      false,
    );
    // A blank node is no id the lookup stores, so it does not count – not
    // even its own statement.
    expect(documents.get('Blank')?.contentLocation_latitude_exists).toBe(false);
  });

  describe('on a lookup into its own type', () => {
    const region = defineSearchType({
      ...place,
      fields: [
        ...place.fields,
        {
          name: 'containedInPlace',
          kind: 'reference',
          path: `<${SCHEMA}containedInPlace>`,
          output: true,
          filterable: true,
          ref: {
            strategy: 'lookup',
            target: 'Place',
            presenceLeaves: ['latitude'],
          },
        },
      ],
    });

    async function projectRegions(batchSize?: number) {
      const [stage] = searchStages({
        schema: searchSchema(region),
        types: [
          {
            searchType: region,
            rootVariable: 'root',
            itemSelector: selectByClass(region),
            transform: [geonamesCoordinates],
            ...(batchSize !== undefined && { batchSize }),
          },
        ],
      });
      const documents = new Map<string, Record<string, unknown>>();
      await stage.run(dataset, distribution, {
        write: async (_dataset, items) => {
          for await (const item of items) {
            documents.set(String(item.document.name_und), item.document);
          }
        },
      });
      return documents;
    }

    it('seeds its referents through the type’s own transforms', async () => {
      seen.length = 0;
      const documents = await projectRegions();

      // Named by IRI alone, and described by the type’s own transform.
      expect(documents.get('Village')?.containedInPlace_latitude_exists).toBe(
        true,
      );
      // Described in the batch, so read as stated and not seeded.
      expect(documents.get('Hamlet')?.containedInPlace_latitude_exists).toBe(
        true,
      );
      expect(documents.get('Isolated')?.containedInPlace_latitude_exists).toBe(
        false,
      );
      expect(seen).toEqual(
        expect.arrayContaining([
          'https://sws.geonames.org/2751283',
          'https://a/place/nowhere',
        ]),
      );
      expect(seen.filter((iri) => iri === 'https://a/place/region')).toEqual([
        'https://a/place/region',
      ]);
      // The seed is not kept: the place still names one place.
      expect(documents.get('Village')?.containedInPlace).toBe(
        'https://sws.geonames.org/2751283',
      );
    });

    it('seeds nothing in a batch that describes every referent', async () => {
      const documents = await projectRegions(1);

      expect(documents.get('Village')?.containedInPlace_latitude_exists).toBe(
        true,
      );
      expect(documents.get('Hamlet')?.containedInPlace_latitude_exists).toBe(
        true,
      );
      expect(documents.get('Isolated')?.containedInPlace_latitude_exists).toBe(
        false,
      );
    });
  });
});
