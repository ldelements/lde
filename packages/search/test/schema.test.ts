import { describe, expect, it } from 'vitest';
import {
  assertTypeInSchema,
  assertValidSearchType,
  displayFieldName,
  displayFieldPattern,
  displayLangOf,
  facetableFields,
  fieldNamed,
  filterableFields,
  inlineFramingDepth,
  irAlias,
  isoToUnixSeconds,
  isRangeFacet,
  outputFields,
  physicalFields,
  referenceFields,
  referenceTypeNamed,
  searchableFields,
  searchSchema,
  sortableFields,
  unixSecondsToIso,
  validateSearchType,
  type SearchField,
  type SearchType,
  type TextField,
} from '../src/schema.js';

const DATASET = 'http://www.w3.org/ns/dcat#Dataset';

const schema: SearchType = {
  name: 'Dataset',
  class: DATASET,
  fields: [
    {
      name: 'title',
      kind: 'text',
      locales: ['nl', 'en'],
      output: true,
      searchable: { weight: 5 },
      sortable: true,
    },
    {
      name: 'description',
      kind: 'text',
      locales: ['nl', 'en'],
      output: true,
      searchable: { weight: 2 },
    },
    {
      name: 'keyword',
      kind: 'keyword',
      array: true,
      facetable: true,
      filterable: true,
      searchable: { weight: 1 },
    },
    {
      name: 'format',
      kind: 'keyword',
      array: true,
      facetable: true,
      filterable: true,
    },
    {
      name: 'datePosted',
      kind: 'date',
      output: true,
      filterable: true,
      sortable: true,
    },
    {
      name: 'status',
      kind: 'keyword',
      facetable: true,
      filterable: true,
      output: true,
    },
  ],
};

describe('physicalFields', () => {
  it('fans a localized text field out into per-locale search and sort keys', () => {
    const title: SearchField = {
      name: 'title',
      kind: 'text',
      locales: ['nl', 'en'],
      output: true,
      searchable: { weight: 5 },
      sortable: true,
    };

    // Display is pattern-based, not enumerated here (see displayFieldPattern).
    expect(physicalFields(title)).toEqual({
      search: ['title_search_nl', 'title_search_en'],
      sort: ['title_sort_nl', 'title_sort_en'],
    });
  });

  it('gives a searchable keyword facet one value field and one folded search field', () => {
    const keyword: SearchField = {
      name: 'keyword',
      kind: 'keyword',
      array: true,
      facetable: true,
      filterable: true,
      searchable: { weight: 1 },
    };

    expect(physicalFields(keyword)).toEqual({
      search: ['keyword_search'],
      sort: [],
    });
  });

  it('emits only the search keys for a search-only localized field (no sort)', () => {
    const creator: SearchField = {
      name: 'creator',
      kind: 'text',
      locales: ['nl', 'en'],
      searchable: { weight: 2 },
    };

    expect(physicalFields(creator)).toEqual({
      search: ['creator_search_nl', 'creator_search_en'],
      sort: [],
    });
  });

  it('emits no per-locale fields when a localized field declares no locales', () => {
    const title: SearchField = {
      name: 'title',
      kind: 'text',
      locales: [],
      output: true,
      searchable: { weight: 5 },
      sortable: true,
    };

    expect(physicalFields(title)).toEqual({
      search: [],
      sort: [],
    });
  });

  it('fans a non-localized reference field out into no companion fields', () => {
    const publisher: SearchField = {
      name: 'publisher',
      kind: 'reference',
      facetable: true,
      filterable: true,
      output: true,
      ref: { typeName: 'Agent', strategy: 'labelOnly' },
    };

    expect(physicalFields(publisher)).toEqual({
      search: [],
      sort: [],
    });
  });
});

describe('irAlias', () => {
  const dataset: SearchType = {
    name: 'Dataset',
    class: DATASET,
    fields: [{ name: 'publisherName', kind: 'text', locales: ['nl'] }],
  };
  const person: SearchType = {
    name: 'Person',
    fields: [{ name: 'label', kind: 'text', locales: ['nl'] }],
  };

  it('mints urn:lde:‹Type›/‹field› from the type and field names', () => {
    expect(irAlias(dataset, dataset.fields[0])).toBe(
      'urn:lde:Dataset/publisherName',
    );
  });

  it('qualifies by type name, so one subject can be a root of two types', () => {
    // Same field name, different declaring type → distinct aliases.
    const datasetLabel = { name: 'label', kind: 'text', locales: ['nl'] };
    expect(irAlias(dataset, datasetLabel as SearchField)).not.toBe(
      irAlias(person, person.fields[0]),
    );
    expect(irAlias(person, person.fields[0])).toBe('urn:lde:Person/label');
  });
});

describe('display field helpers', () => {
  const label: TextField = {
    name: 'label',
    kind: 'text',
    locales: ['nl', 'en'],
    output: true,
    searchable: { weight: 1 },
  };

  it('names a display field per language, tag preserved (untagged under und)', () => {
    expect(displayFieldName(label, 'nl')).toBe('label_nl');
    expect(displayFieldName(label, 'fr')).toBe('label_fr');
    expect(displayFieldName(label, 'zh-hant')).toBe('label_zh-hant');
    expect(displayFieldName(label, 'und')).toBe('label_und');
  });

  it('declares one regex display field for an output text field, none otherwise', () => {
    expect(displayFieldPattern(label)).toBe('label_[^_]+');
    const searchOnly: TextField = {
      name: 'creator',
      kind: 'text',
      locales: ['nl'],
      searchable: { weight: 1 },
    };
    expect(displayFieldPattern(searchOnly)).toBeUndefined();
  });

  it('recovers the language of a display key, rejecting search/sort companions', () => {
    expect(displayLangOf(label, 'label_nl')).toBe('nl');
    expect(displayLangOf(label, 'label_fr')).toBe('fr');
    expect(displayLangOf(label, 'label_zh-hant')).toBe('zh-hant');
    expect(displayLangOf(label, 'label_und')).toBe('und');
    // The underscore-free rule excludes the indexed companions and the bare name.
    expect(displayLangOf(label, 'label_search_nl')).toBeUndefined();
    expect(displayLangOf(label, 'label_sort_nl')).toBeUndefined();
    expect(displayLangOf(label, 'label')).toBeUndefined();
    // A different field’s display key is not misattributed.
    expect(displayLangOf(label, 'other_nl')).toBeUndefined();
  });

  it('round-trips displayFieldName through displayLangOf, and the pattern matches', () => {
    // Binds the three builders to one convention so they cannot silently drift.
    const pattern = new RegExp(`^${displayFieldPattern(label)}$`);
    for (const lang of ['nl', 'en', 'fr', 'zh-hant', 'und']) {
      const key = displayFieldName(label, lang);
      expect(displayLangOf(label, key)).toBe(lang);
      expect(pattern.test(key)).toBe(true);
    }
    // The search/sort companions fall outside the display pattern.
    expect(pattern.test('label_search_nl')).toBe(false);
    expect(pattern.test('label_sort_nl')).toBe(false);
  });
});

describe('schema selectors', () => {
  it('orders searchable fields by descending weight', () => {
    expect(searchableFields(schema).map((field) => field.name)).toEqual([
      'title',
      'description',
      'keyword',
    ]);
  });

  it('selects facetable, filterable, sortable and output fields by capability', () => {
    expect(facetableFields(schema).map((field) => field.name)).toEqual([
      'keyword',
      'format',
      'status',
    ]);
    expect(filterableFields(schema).map((field) => field.name)).toEqual([
      'keyword',
      'format',
      'datePosted',
      'status',
    ]);
    expect(sortableFields(schema).map((field) => field.name)).toEqual([
      'title',
      'datePosted',
    ]);
    expect(outputFields(schema).map((field) => field.name)).toEqual([
      'title',
      'description',
      'datePosted',
      'status',
    ]);
  });

  it('selects reference fields and looks a field up by name', () => {
    const publisher: SearchField = {
      name: 'publisher',
      kind: 'reference',
      facetable: true,
      ref: { typeName: 'Agent', strategy: 'labelOnly' },
    };
    const withReference: SearchType = {
      name: 'Dataset',
      class: DATASET,
      fields: [...schema.fields, publisher],
    };
    expect(referenceFields(withReference)).toEqual([publisher]);
    expect(fieldNamed(withReference, 'publisher')).toBe(publisher);
    expect(fieldNamed(withReference, 'nonexistent')).toBeUndefined();
  });
});

describe('isRangeFacet', () => {
  it('requires a non-empty facetRanges declaration', () => {
    const size: SearchField = {
      name: 'size',
      kind: 'integer',
      facetable: true,
      facetRanges: [{ key: '0', min: 1, max: 10 }],
    };
    expect(isRangeFacet(size)).toBe(true);
    expect(isRangeFacet({ ...size, facetRanges: [] })).toBe(false);
    expect(isRangeFacet({ ...size, facetRanges: undefined })).toBe(false);
  });
});

describe('validateSearchType', () => {
  // Deliberately untyped: these tests exercise the RUNTIME guard for
  // declarations built outside TypeScript (a SHACL generator, plain JS),
  // which the discriminated SearchField union would reject at compile time.
  const typeWith = (...fields: object[]): SearchType => ({
    name: 'Dataset',
    class: DATASET,
    fields: fields as SearchField[],
  });

  it('accepts a well-formed declaration', () => {
    expect(validateSearchType(schema)).toEqual([]);
    expect(() => assertValidSearchType(schema)).not.toThrow();
  });

  it('rejects duplicate field names', () => {
    const type = typeWith(
      { name: 'status', kind: 'keyword' },
      { name: 'status', kind: 'boolean' },
    );
    expect(validateSearchType(type)).toEqual([
      { field: 'status', reason: 'duplicate-field-name' },
    ]);
  });

  it('rejects a field name carrying a regex metacharacter', () => {
    // The name is interpolated raw into the display RE2 pattern, so a
    // metacharacter would over-match or break the collection schema.
    expect(
      validateSearchType(typeWith({ name: 'v1.2', kind: 'keyword' })),
    ).toEqual([{ field: 'v1.2', reason: 'invalid-field-name' }]);
  });

  it('rejects a declared locale containing an underscore', () => {
    // `_` is the reserved name↔locale separator; a locale carrying one would
    // collide with the physical/display field naming.
    expect(
      validateSearchType(
        typeWith({ name: 'title', kind: 'text', locales: ['pt_BR'] }),
      ),
    ).toEqual([{ field: 'title', reason: 'invalid-locale' }]);
    // A BCP-47 hyphenated subtag is accepted.
    expect(
      validateSearchType(
        typeWith({
          name: 'title',
          kind: 'text',
          locales: ['pt-BR', 'zh-Hant', 'und'],
        }),
      ),
    ).toEqual([]);
  });

  it('requires ref on an output reference field, but not on a facet-only one', () => {
    expect(
      validateSearchType(
        typeWith({ name: 'publisher', kind: 'reference', output: true }),
      ),
    ).toEqual([{ field: 'publisher', reason: 'missing-ref' }]);
    expect(
      validateSearchType(
        typeWith({ name: 'class', kind: 'reference', facetable: true }),
      ),
    ).toEqual([]);
  });

  it('rejects ref on a non-reference kind', () => {
    const type = typeWith({
      name: 'format',
      kind: 'keyword',
      ref: { typeName: 'Format', strategy: 'labelOnly' },
    });
    expect(validateSearchType(type)).toEqual([
      { field: 'format', reason: 'ref-not-allowed' },
    ]);
  });

  it('requires text to declare at least one locale (und counts)', () => {
    expect(
      validateSearchType(typeWith({ name: 'title', kind: 'text' })),
    ).toEqual([{ field: 'title', reason: 'text-requires-locales' }]);
    expect(
      validateSearchType(
        typeWith({ name: 'title', kind: 'text', locales: [] }),
      ),
    ).toEqual([{ field: 'title', reason: 'text-requires-locales' }]);
    // An untagged corpus declares the reserved `und` locale.
    expect(
      validateSearchType(
        typeWith({ name: 'title', kind: 'text', locales: ['und'] }),
      ),
    ).toEqual([]);
  });

  it('rejects locales on a non-text kind', () => {
    expect(
      validateSearchType(
        typeWith({ name: 'format', kind: 'keyword', locales: ['nl'] }),
      ),
    ).toEqual([{ field: 'format', reason: 'locales-not-allowed' }]);
  });

  it('rejects filterable and facetable on text (it feeds the free-text query)', () => {
    const type = typeWith({
      name: 'title',
      kind: 'text',
      locales: ['nl'],
      filterable: true,
      facetable: true,
    });
    expect(validateSearchType(type)).toEqual([
      { field: 'title', reason: 'text-not-filterable' },
      { field: 'title', reason: 'text-not-facetable' },
    ]);
  });

  it('allows facetRanges on numeric kinds only', () => {
    const ranges = [{ key: 'small', max: 10 }];
    expect(
      validateSearchType(
        typeWith({
          name: 'size',
          kind: 'integer',
          facetable: true,
          facetRanges: ranges,
        }),
      ),
    ).toEqual([]);
    expect(
      validateSearchType(
        typeWith({
          name: 'format',
          kind: 'keyword',
          facetable: true,
          facetRanges: ranges,
        }),
      ),
    ).toEqual([{ field: 'format', reason: 'facet-ranges-not-allowed' }]);
  });

  it('allows searchable on text/keyword/reference only', () => {
    expect(
      validateSearchType(
        typeWith({ name: 'size', kind: 'integer', searchable: { weight: 1 } }),
      ),
    ).toEqual([{ field: 'size', reason: 'searchable-not-allowed' }]);
  });

  it('rejects a field declaring both path and derive', () => {
    expect(
      validateSearchType(
        typeWith({
          name: 'status',
          kind: 'keyword',
          path: 'urn:dr:status',
          derive: () => 'valid',
        }),
      ),
    ).toEqual([{ field: 'status', reason: 'derive-with-path' }]);
  });

  it('allows transform on keyword/reference only', () => {
    expect(
      validateSearchType(
        typeWith({
          name: 'size',
          kind: 'integer',
          transform: (value: string) => value,
        }),
      ),
    ).toEqual([{ field: 'size', reason: 'transform-not-allowed' }]);
  });
});

describe('assertTypeInSchema', () => {
  it('accepts a member and rejects a foreign or lookalike type', () => {
    const withSchema = searchSchema(schema);
    expect(() => assertTypeInSchema(withSchema, schema)).not.toThrow();
    // A structural copy is not the declared member: identity-based.
    expect(() => assertTypeInSchema(withSchema, { ...schema })).toThrow(
      /not in this engine’s schema; it serves “Dataset”/,
    );
  });
});

describe('searchSchema validation', () => {
  it('throws on an invalid declaration, naming type, field and reason', () => {
    expect(() =>
      searchSchema({
        name: 'Dataset',
        class: DATASET,
        fields: [
          {
            name: 'title',
            kind: 'text',
            locales: [],
          } as unknown as SearchField,
        ],
      }),
    ).toThrow(
      /Invalid search type “Dataset”: “title” \(text-requires-locales\)/,
    );
  });

  it('rejects two types sharing a type IRI (the map key)', () => {
    expect(() =>
      searchSchema(
        { name: 'Dataset', class: DATASET, fields: [] },
        { name: 'Other', class: DATASET, fields: [] },
      ),
    ).toThrow(/Duplicate search type IRI/);
  });

  it('rejects two types sharing a name (the API key)', () => {
    expect(() =>
      searchSchema(
        { name: 'Dataset', class: DATASET, fields: [] },
        { name: 'Dataset', class: 'urn:other', fields: [] },
      ),
    ).toThrow(/Duplicate search type name/);
  });

  describe('reference types and inline references', () => {
    const registration = {
      name: 'Registration',
      fields: [
        { name: 'dateRead', kind: 'date', path: 'https://schema.org/dateRead' },
        {
          name: 'datePosted',
          kind: 'date',
          path: 'https://schema.org/datePosted',
        },
      ],
    } as const;

    const datasetWithInline = {
      name: 'Dataset',
      class: DATASET,
      fields: [
        {
          name: 'registration',
          kind: 'reference',
          array: true,
          path: 'urn:lde:Dataset/registration',
          ref: { typeName: 'Registration', strategy: 'inline' },
        },
      ],
    } as const;

    it('accepts a reference type (no class) and keeps it out of the indexed map', () => {
      const schema = searchSchema(datasetWithInline, registration);
      // The class-keyed map – and so every writer’s collections – holds only
      // the Root Type. The Reference Type is reachable only through the
      // reference.
      expect([...schema.values()].map((type) => type.name)).toEqual([
        'Dataset',
      ]);
      expect(referenceTypeNamed(schema, 'Registration')).toEqual(registration);
      expect(referenceTypeNamed(schema, 'Dataset')).toBeUndefined();
    });

    it('resolves an inline ref.typeName against the declared reference types', () => {
      expect(() => searchSchema(datasetWithInline, registration)).not.toThrow();
    });

    it('rejects an inline reference whose typeName names no declared type', () => {
      expect(() => searchSchema(datasetWithInline)).toThrow(
        /inline reference .*Registration.*declare a reference type/i,
      );
    });

    it('rejects an inline reference resolving to a root type, not a reference type', () => {
      expect(() =>
        searchSchema(datasetWithInline, {
          name: 'Registration',
          class: 'urn:other',
          fields: [],
        }),
      ).toThrow(/inline reference .*Registration.*reference type/i);
    });

    it('rejects an inline cycle', () => {
      const a = {
        name: 'A',
        fields: [
          {
            name: 'toB',
            kind: 'reference',
            path: 'urn:lde:A/toB',
            ref: { typeName: 'B', strategy: 'inline' },
          },
        ],
      } as const;
      const b = {
        name: 'B',
        fields: [
          {
            name: 'toA',
            kind: 'reference',
            path: 'urn:lde:B/toA',
            ref: { typeName: 'A', strategy: 'inline' },
          },
        ],
      } as const;
      expect(() =>
        searchSchema(
          {
            name: 'Dataset',
            class: DATASET,
            fields: [
              {
                name: 'a',
                kind: 'reference',
                path: 'urn:lde:Dataset/a',
                ref: { typeName: 'A', strategy: 'inline' },
              },
            ],
          },
          a,
          b,
        ),
      ).toThrow(/inline (reference )?cycle/i);
    });

    it('computes the framing depth from the inline reference chain', () => {
      const measurement = {
        name: 'Measurement',
        fields: [
          {
            name: 'value',
            kind: 'number',
            path: 'http://www.w3.org/ns/dqv#value',
          },
        ],
      } as const;
      const subset = {
        name: 'Subset',
        fields: [
          {
            name: 'measurement',
            kind: 'reference',
            array: true,
            path: 'http://www.w3.org/ns/dqv#hasQualityMeasurement',
            ref: { typeName: 'Measurement', strategy: 'inline' },
          },
        ],
      } as const;
      const dataset = {
        name: 'Dataset',
        class: DATASET,
        fields: [
          {
            name: 'subset',
            kind: 'reference',
            array: true,
            path: 'http://rdfs.org/ns/void#subset',
            ref: { typeName: 'Subset', strategy: 'inline' },
          },
        ],
      } as const;
      const chainSchema = searchSchema(dataset, subset, measurement);
      // Dataset → Subset → Measurement is two hops.
      expect(inlineFramingDepth(chainSchema, dataset)).toBe(2);
      // A root type with no inline reference frames its own one hop.
      const flatDataset = {
        name: 'Flat',
        class: 'urn:flat',
        fields: [],
      } as const;
      expect(inlineFramingDepth(searchSchema(flatDataset), flatDataset)).toBe(
        1,
      );
      // Against a schema that does not declare the referent, an inline reference
      // contributes no depth (the type is being framed through a foreign schema).
      expect(inlineFramingDepth(searchSchema(flatDataset), dataset)).toBe(1);
    });
  });

  describe('reference label sources', () => {
    const organization = {
      name: 'Organization',
      class: 'https://example.org/Organization',
      fields: [
        {
          name: 'label',
          kind: 'text',
          locales: ['und', 'nl'],
          output: true,
          searchable: { weight: 1 },
        },
      ],
    } as const;

    it('accepts a reference whose labelSource names a type with a resolvable label', () => {
      expect(() =>
        searchSchema(organization, {
          name: 'Dataset',
          class: DATASET,
          fields: [
            {
              name: 'publisher',
              kind: 'reference',
              facetable: true,
              labelSource: 'Organization',
            },
          ],
        }),
      ).not.toThrow();
    });

    it('rejects a labelSource that names no declared type', () => {
      expect(() =>
        searchSchema({
          name: 'Dataset',
          class: DATASET,
          fields: [
            {
              name: 'publisher',
              kind: 'reference',
              labelSource: 'Organization',
            },
          ],
        }),
      ).toThrow(/label source “Organization”/);
    });

    it('rejects a label source without an output, searchable text “label” field', () => {
      const withLabelField = (label: Record<string, unknown>) => () =>
        searchSchema(
          {
            name: 'Organization',
            class: 'https://example.org/Organization',
            fields: [{ name: 'label', kind: 'text', ...label } as never],
          },
          {
            name: 'Dataset',
            class: DATASET,
            fields: [
              {
                name: 'publisher',
                kind: 'reference',
                labelSource: 'Organization',
              },
            ],
          },
        );

      // Not output: nothing to reconstruct a label from.
      expect(
        withLabelField({ locales: ['und'], searchable: { weight: 1 } }),
      ).toThrow(/label source/);
      // Not searchable: nothing to type ahead against, and no query_by.
      expect(withLabelField({ locales: ['und'], output: true })).toThrow(
        /label source/,
      );
      // No `label` field at all.
      expect(() =>
        searchSchema(
          {
            name: 'Organization',
            class: 'https://example.org/Organization',
            fields: [],
          },
          {
            name: 'Dataset',
            class: DATASET,
            fields: [
              {
                name: 'publisher',
                kind: 'reference',
                labelSource: 'Organization',
              },
            ],
          },
        ),
      ).toThrow(/label source/);
    });

    it('rejects a labelSource on a non-reference field', () => {
      expect(() =>
        searchSchema(organization, {
          name: 'Dataset',
          class: DATASET,
          fields: [
            {
              name: 'theme',
              kind: 'keyword',
              labelSource: 'Organization',
            } as never,
          ],
        }),
      ).toThrow(/declares a label source but is a keyword field/);
    });
  });
});

describe('date storage codec', () => {
  it('round-trips ISO 8601 through the stored Unix seconds', () => {
    const seconds = isoToUnixSeconds('2024-01-01T00:00:00.000Z');
    expect(seconds).toBe(Date.parse('2024-01-01T00:00:00.000Z') / 1000);
    expect(unixSecondsToIso(seconds ?? 0)).toBe('2024-01-01T00:00:00.000Z');
  });

  it('returns undefined for an unparseable date', () => {
    expect(isoToUnixSeconds('not-a-date')).toBeUndefined();
  });
});
