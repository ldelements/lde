import { describe, expect, it } from 'vitest';
import type { Client } from 'typesense';
import {
  defineSearchType,
  searchSchema,
  type RootType,
  type SearchQuery,
} from '@lde/search';
import { deriveCollectionName } from '../src/collection-name.js';
import { buildCollectionDefinition } from '../src/collection-definition.js';
import { createTypesenseSearchEngine } from '../src/search.js';
import { BlueGreenRebuild } from '../src/blue-green-rebuild.js';
import { InPlaceRebuild } from '../src/in-place-rebuild.js';
import { fakeTypesenseClient, labelLookup } from './fake-typesense-client.js';

const typeNamed = (name: string): RootType => ({
  name,
  class: `https://example.org/${name}`,
  fields: [{ name: 'title', kind: 'keyword' }],
});

/** Neither the writers nor the engine touch a client at construction, so the
 *  naming can be asserted without one. */
const noClient = {} as Client;

describe('deriveCollectionName', () => {
  it.each([
    // The convention is Typesense’s own, as its docs write collection names:
    // https://typesense.org/docs/guide/organizing-collections.html
    ['CreativeWork', 'creative_works'],
    ['BlogArticle', 'blog_articles'],
    ['Company', 'companies'],
    ['Person', 'people'],
    ['Dataset', 'datasets'],
    ['TVSeries', 'tv_series'],
    ['DCATDataset', 'dcat_datasets'],
  ])('names the collection for %s “%s”', (name, expected) => {
    expect(deriveCollectionName(typeNamed(name))).toBe(expected);
  });

  it('rejects a name that is legal to spell but not to call a collection', () => {
    // `123` spells fine (`123s`); a collection name opening with a digit is
    // this engine’s rule to make, so this is the check that stays here.
    expect(() => deriveCollectionName(typeNamed('123'))).toThrow(
      /it yields “123s”, which is not a legal collection name/,
    );
  });

  it.each(['Café', '---'])(
    'passes %s through to the engine-neutral spelling rule',
    (name) => {
      // The rule that a name must be spellable at all lives in @lde/search, so
      // no adapter can derive a name without it – this only proves it fires.
      expect(() => deriveCollectionName(typeNamed(name))).toThrow(
        /Cannot name search type/,
      );
    },
  );

  it('still accepts a name written with word separators', () => {
    expect(deriveCollectionName(typeNamed('creative_work'))).toBe(
      'creative_works',
    );
    expect(deriveCollectionName(typeNamed('Creative Work'))).toBe(
      'creative_works',
    );
  });
});

describe('buildCollectionDefinition', () => {
  it('derives the collection name from the type when none is given', () => {
    expect(buildCollectionDefinition(typeNamed('CreativeWork')).name).toBe(
      'creative_works',
    );
  });

  it('lets an explicit name override the derived one', () => {
    const definition = buildCollectionDefinition(typeNamed('CreativeWork'), {
      name: 'staging_creative_works',
    });
    expect(definition.name).toBe('staging_creative_works');
  });
});

describe('the writers and the engine agree on a type’s collection', () => {
  const creativeWork = typeNamed('CreativeWork');
  const schema = searchSchema(creativeWork);

  it('derives the same name on the write side and the read side', () => {
    // The point of the issue: an adapter owns both its writers and its engine,
    // so documents cannot be written to one collection and queried from
    // another.
    const engine = createTypesenseSearchEngine(noClient, schema);

    expect(new InPlaceRebuild(noClient, creativeWork).collectionName).toBe(
      'creative_works',
    );
    expect(new BlueGreenRebuild(noClient, creativeWork).collectionName).toBe(
      'creative_works',
    );
    expect(engine.collectionNameFor(creativeWork)).toBe('creative_works');
  });

  it('honours the explicit override on both sides', () => {
    const engine = createTypesenseSearchEngine(noClient, schema, {
      collections: { CreativeWork: 'staging_works' },
    });
    const options = { name: 'staging_works' };

    expect(
      new InPlaceRebuild(noClient, creativeWork, options).collectionName,
    ).toBe('staging_works');
    expect(
      new BlueGreenRebuild(noClient, creativeWork, options).collectionName,
    ).toBe('staging_works');
    expect(engine.collectionNameFor(creativeWork)).toBe('staging_works');
  });

  it('overrides only the type named, leaving its siblings derived', () => {
    const person = typeNamed('Person');
    const mixed = searchSchema(creativeWork, person);
    const engine = createTypesenseSearchEngine(noClient, mixed, {
      collections: { CreativeWork: 'staging_works' },
    });

    expect(engine.collectionNameFor(creativeWork)).toBe('staging_works');
    expect(engine.collectionNameFor(person)).toBe('people');
  });

  // English collapses these two distinct names onto one collection: both
  // derive `media`. The schema itself is happy – the names differ.
  const medium = typeNamed('Medium');
  const media = typeNamed('Media');

  it('rejects two types whose names derive to one collection, which nobody asked for', () => {
    // Left alone, each type’s search would return the other’s documents.
    expect(() =>
      createTypesenseSearchEngine(noClient, searchSchema(medium, media)),
    ).toThrow(
      /Search types “Medium” and “Media” would share the Typesense collection “media”/,
    );
  });

  it('accepts the collision once an override separates the two', () => {
    const engine = createTypesenseSearchEngine(
      noClient,
      searchSchema(medium, media),
      { collections: { Medium: 'mediums' } },
    );

    expect(engine.collectionNameFor(medium)).toBe('mediums');
    expect(engine.collectionNameFor(media)).toBe('media');
  });

  it('still lets types deliberately share one collection, both named explicitly', () => {
    // Several label sources served by one `labels` collection is a reasonable
    // deployment, so an explicit pairing is the deployment’s to make.
    expect(() =>
      createTypesenseSearchEngine(noClient, searchSchema(medium, media), {
        collections: { Medium: 'labels', Media: 'labels' },
      }),
    ).not.toThrow();
  });

  it('rejects a type outside the schema, like every other entry point', () => {
    const engine = createTypesenseSearchEngine(noClient, schema);

    expect(() => engine.collectionNameFor(typeNamed('Foreign'))).toThrow(
      /is not in this engine’s schema/,
    );
  });

  it('gives a reference type no collection – only root types are indexed', () => {
    const registration = defineSearchType({
      name: 'Registration',
      fields: [
        { name: 'dateRead', kind: 'date', path: 'https://schema.org/dateRead' },
      ],
    });
    const dataset = defineSearchType({
      name: 'Dataset',
      class: 'https://example.org/Dataset',
      fields: [
        {
          name: 'registration',
          kind: 'reference',
          output: true,
          path: 'urn:lde:Dataset/registration',
          ref: { typeName: 'Registration', strategy: 'inline' },
        },
      ],
    });
    const engine = createTypesenseSearchEngine(
      noClient,
      searchSchema(dataset, registration),
    );
    // The Root Type has a collection…
    expect(engine.collectionNameFor(dataset)).toBe('datasets');
    // …but the Reference Type is not indexed: asking for its collection is a
    // compile error (it is absent from the engine’s served types) and rejects
    // at run time too.
    expect(() =>
      // @ts-expect-error a reference type has no collection.
      engine.collectionNameFor(registration),
    ).toThrow(/is not in this engine’s schema/);
  });
});

describe('label sources', () => {
  const organization: RootType = {
    name: 'Organization',
    class: 'http://xmlns.com/foaf/0.1/Organization',
    fields: [
      {
        name: 'label',
        kind: 'text',
        locales: ['nl'],
        output: true,
        searchable: { weight: 1 },
      },
    ],
  };
  const dataset: RootType = {
    name: 'Dataset',
    class: 'http://www.w3.org/ns/dcat#Dataset',
    fields: [
      {
        name: 'publisher',
        kind: 'reference',
        output: true,
        labelSource: 'Organization',
        ref: { typeName: 'Organization', strategy: 'labelOnly' },
      },
    ],
  };
  const schema = searchSchema(organization, dataset);

  const browse: SearchQuery = {
    text: '',
    where: [],
    facets: [],
    orderBy: [],
    limit: 10,
    offset: 0,
    locale: 'nl',
  };

  it('resolves a reference’s labels from the label type’s derived collection', async () => {
    const fake = fakeTypesenseClient({
      searchResponse: {
        found: 1,
        hits: [{ document: { id: 'https://d/1', publisher: 'https://org/1' } }],
      },
      multiSearch: labelLookup({
        'https://org/1': { label_nl: 'Het Archief' },
      }),
    });
    const engine = createTypesenseSearchEngine(fake.client, schema);

    const result = await engine.search(dataset, browse);

    // The label lookup must target the collection the Organization writer
    // would have built – the same convention, never a second naming map.
    expect(fake.performs[0][0].collection).toBe('organizations');
    expect(result.hits[0].document.publisher).toEqual({
      id: 'https://org/1',
      label: { nl: ['Het Archief'] },
    });
  });

  it('resolves labels from the label type’s override when it has one', async () => {
    const fake = fakeTypesenseClient({
      searchResponse: {
        found: 1,
        hits: [{ document: { id: 'https://d/1', publisher: 'https://org/1' } }],
      },
      multiSearch: labelLookup({
        'https://org/1': { label_nl: 'Het Archief' },
      }),
    });
    const engine = createTypesenseSearchEngine(fake.client, schema, {
      collections: { Organization: 'labels' },
    });

    await engine.search(dataset, browse);

    expect(fake.performs[0][0].collection).toBe('labels');
  });
});
