import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Dataset, Distribution } from '@lde/dataset';
import type {
  DatasetWriter,
  QuadTransform,
  ReaderContext,
} from '@lde/pipeline';
import { defineSearchType, searchSchema, type RootType } from '@lde/search';
import { irAlias } from '@lde/search/adapter';
import { DataFactory } from 'n3';
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
      searchable: { weight: 1 },
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
    placeTransform?: QuadTransform<ReaderContext>,
  ): Promise<Record<string, unknown>[]> {
    const [stage] = searchStages({
      schema,
      types: [
        {
          searchType,
          rootVariable: 'root',
          itemSelector: selectByClass(searchType),
        },
        // Declared so its transform is known; only the first type’s stage runs.
        ...(placeTransform === undefined
          ? []
          : [
              {
                searchType: place,
                rootVariable: 'root',
                itemSelector: selectByClass(place),
                transform: placeTransform,
              },
            ]),
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

  it('makes each work searchable by its place’s label, not its IRI', async () => {
    const byName = Object.fromEntries(
      (await project(creativeWork)).map((document) => [
        document.name_nl,
        document,
      ]),
    );

    // Folded, as every search companion is, and read from the publisher’s node
    // whatever key the reference stores.
    expect(byName['Werk 1'].locationCreated_search).toBe('venlo');
    expect(byName['Werk 2'].locationCreated_search).toBe('kessel');
    expect(byName['Werk 3'].locationCreated_search).toBe('roermond');
  });

  it('searches each work by its place’s label as the place’s transform makes it', async () => {
    // A transform on `Place` replacing Kessel’s name, as an Authority’s
    // description replaces a publisher’s.
    const nameAlias = irAlias(place, place.fields[0]);
    const renameKessel: QuadTransform<ReaderContext> = async function* (quads) {
      for await (const quad of quads) {
        yield quad.subject.value === 'https://a/place/kessel' &&
        quad.predicate.value === nameAlias
          ? DataFactory.quad(
              quad.subject,
              quad.predicate,
              DataFactory.literal('Kessel aan de Maas'),
            )
          : quad;
      }
    };
    const byName = Object.fromEntries(
      (await project(creativeWork, renameKessel)).map((document) => [
        document.name_nl,
        document,
      ]),
    );

    // No `Place` stage ran: the work’s own stage applied the transform.
    expect(byName['Werk 2'].locationCreated_search).toBe('kessel aan de maas');
    expect(byName['Werk 2'].locationCreated).toBe('https://a/place/kessel');
    expect(byName['Werk 3'].locationCreated_search).toBe('roermond');
    expect(byName['Werk 1'].locationCreated).toBe(`${GEONAMES}2745707`);
  });
});

describe('a searchable reference’s referents, through their type’s transform', () => {
  const port = 3019;
  const distribution = Distribution.sparql(
    new URL(`http://localhost:${port}/sparql`),
  );
  const dataset = new Dataset({
    iri: new URL('http://example.org/dataset/referents'),
    distributions: [distribution],
  });

  // An unkeyed place: a referent carries its label alone.
  const plainPlace = defineSearchType({
    name: 'PlainPlace',
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
    ],
  });
  // A label source no transform is declared for.
  const untransformed = defineSearchType({
    ...plainPlace,
    name: 'UntransformedPlace',
    class: 'https://example.org/UntransformedPlace',
  });
  const reference = (name: string, target: string) =>
    ({
      name,
      kind: 'reference',
      path: `<${SCHEMA}locationCreated>`,
      output: true,
      searchable: { weight: 1 },
      ref: { strategy: 'lookup', target },
    }) as const;
  const work = defineSearchType({
    name: 'Work',
    class: `${SCHEMA}CreativeWork`,
    labelField: 'name',
    fields: [
      {
        name: 'name',
        kind: 'text',
        path: `<${SCHEMA}name>`,
        locales: ['nl'],
        output: true,
        searchable: { weight: 5 },
      },
      // Two references naming one target.
      reference('locationCreated', 'PlainPlace'),
      reference('contentLocation', 'PlainPlace'),
      reference('untransformed', 'UntransformedPlace'),
      // A reference to its own type: its stage’s transform saw the batch.
      { ...reference('isPartOf', 'Work'), path: `<${SCHEMA}isPartOf>` },
    ],
  });
  const referentSchema = searchSchema(work, plainPlace, untransformed);

  beforeAll(async () => {
    await startSparqlEndpoint(
      port,
      fileURLToPath(
        new URL('./fixtures/keyed-places-sample.ttl', import.meta.url),
      ),
    );
  }, 60_000);

  afterAll(async () => {
    await teardownSparqlEndpoint();
  });

  it('applies the target’s transform after the stage’s own, for every reference naming it', async () => {
    const seen: string[] = [];
    const nameAlias = irAlias(plainPlace, plainPlace.fields[0]);
    const upperCaseNames: QuadTransform<ReaderContext> = async function* (
      quads,
    ) {
      seen.push('place');
      for await (const quad of quads) {
        yield quad.predicate.value === nameAlias
          ? DataFactory.quad(
              quad.subject,
              quad.predicate,
              DataFactory.literal(`${quad.object.value} (plaats)`),
            )
          : quad;
      }
    };
    const ownTransform: QuadTransform<ReaderContext> = async function* (quads) {
      seen.push('work');
      yield* quads;
    };
    const [stage] = searchStages({
      schema: referentSchema,
      types: [
        {
          searchType: work,
          rootVariable: 'root',
          itemSelector: selectByClass(work),
          transform: ownTransform,
        },
        {
          searchType: plainPlace,
          rootVariable: 'root',
          itemSelector: selectByClass(plainPlace),
          transform: [upperCaseNames],
        },
      ],
    });
    const documents: Record<string, unknown>[] = [];
    await stage.run(dataset, distribution, {
      write: async (_dataset, items) => {
        for await (const item of items) {
          documents.push(item.document);
        }
      },
    });
    const werk2 = documents.find((document) => document.name_nl === 'Werk 2');

    // One batch: the stage’s own transform, then the referents’ pass.
    expect(seen).toEqual(['work', 'place']);
    expect(werk2?.locationCreated_search).toBe('kessel (plaats)');
    expect(werk2?.contentLocation_search).toBe('kessel (plaats)');
    // The same referent, read for a target with no transform: as stated.
    expect(werk2?.untransformed_search).toBe('kessel');
  });

  it('applies it to an endpoint the graph states without its edge', async () => {
    const placeRole = defineSearchType({
      name: 'PlaceRole',
      edgeClass: `${SCHEMA}Role`,
      fields: [
        {
          name: 'roleName',
          kind: 'keyword',
          output: true,
          path: `<${SCHEMA}roleName>`,
        },
        { ...reference('place', 'PlainPlace'), filterable: true },
      ],
    });
    const roleWork = defineSearchType({
      ...work,
      fields: [
        work.fields[0],
        {
          name: 'created',
          kind: 'reference',
          output: true,
          path: `<${SCHEMA}locationCreated>`,
          facetable: true,
          ref: { strategy: 'inline', typeName: 'PlaceRole', identity: 'place' },
        },
      ],
    });
    const nameAlias = irAlias(plainPlace, plainPlace.fields[0]);
    const [stage] = searchStages({
      schema: searchSchema(roleWork, placeRole, plainPlace),
      types: [
        {
          searchType: roleWork,
          rootVariable: 'root',
          itemSelector: selectByClass(roleWork),
        },
        {
          searchType: plainPlace,
          rootVariable: 'root',
          itemSelector: selectByClass(plainPlace),
          transform: async function* (quads) {
            for await (const quad of quads) {
              yield quad.predicate.value === nameAlias
                ? DataFactory.quad(
                    quad.subject,
                    quad.predicate,
                    DataFactory.literal(`${quad.object.value} (plaats)`),
                  )
                : quad;
            }
          },
        },
      ],
    });
    const documents: Record<string, unknown>[] = [];
    await stage.run(dataset, distribution, {
      write: async (_dataset, items) => {
        for await (const item of items) {
          documents.push(item.document);
        }
      },
    });

    // The work points straight at the place: no Role in between.
    expect(
      documents.find((document) => document.name_nl === 'Werk 2')?.created,
    ).toEqual({
      place: 'https://a/place/kessel',
      place_search: 'kessel (plaats)',
    });
  });
});
