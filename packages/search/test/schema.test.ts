import { describe, expect, it } from 'vitest';
import {
  assertTypeInSchema,
  assertValidSearchType,
  datasetField,
  displayFieldName,
  documentKeyOf,
  displayFieldPattern,
  displayLangOf,
  facetableFields,
  fieldNamed,
  filterableFields,
  inlineFramingDepth,
  irAlias,
  isAbsoluteIri,
  isoToUnixSeconds,
  isInternalField,
  isRangeFacet,
  labelSourceNameOf,
  nestedFieldName,
  nestedReferenceType,
  outputFields,
  physicalFields,
  referenceFields,
  referenceTypeNamed,
  rootTypeNamed,
  searchableFields,
  searchSchema,
  sortableFields,
  unixSecondsToIso,
  validateSearchType,
  type KeyField,
  type ReferenceStrategy,
  type RootType,
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
      facet: 'keyword',
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
      ref: { strategy: 'lookup', target: 'Agent' },
    };

    expect(physicalFields(publisher)).toEqual({
      search: [],
      sort: [],
      facet: 'publisher',
    });
  });

  it('facets a reference on its `_facet` companion only when the type it names declares a policy', () => {
    const agent: SearchType = {
      name: 'Agent',
      class: 'urn:x:Agent',
      labelField: 'label',
      facetKeys: { only: (id) => id.startsWith('https://viaf.org/') },
      fields: [
        {
          name: 'label',
          kind: 'text',
          locales: ['und'],
          output: true,
          searchable: { weight: 1 },
        },
      ],
    };
    const publisher: SearchField = {
      name: 'publisher',
      kind: 'reference',
      facetable: true,
      ref: { strategy: 'lookup', target: 'Agent' },
    };
    const creator: SearchField = {
      name: 'creator',
      kind: 'reference',
      facetable: true,
      labelSource: 'Agent',
    };
    const mentions: SearchField = {
      // Names no type, so it inherits nothing – whatever its values point at.
      name: 'mentions',
      kind: 'reference',
      facetable: true,
    };
    const derived: SearchField = {
      // Produces its own values rather than reading a referent: re-keyed by
      // nothing, narrowed by nothing.
      name: 'derived',
      kind: 'reference',
      facetable: true,
      labelSource: 'Agent',
      derive: () => 'https://viaf.org/1',
    };
    const schema = searchSchema(agent, {
      name: 'Dataset',
      class: 'urn:x:Dataset',
      fields: [publisher, creator, mentions, derived],
    });

    expect(physicalFields(publisher, schema).facet).toBe('publisher_facet');
    expect(physicalFields(creator, schema).facet).toBe('creator_facet');
    expect(physicalFields(mentions, schema).facet).toBe('mentions');
    expect(physicalFields(derived, schema).facet).toBe('derived');
    // Without the schema the target cannot be resolved – the same reading the
    // projection makes without one.
    expect(physicalFields(publisher).facet).toBe('publisher');
    // A facet companion is a role’s fanout, like a search companion: none
    // without the role.
    expect(
      physicalFields({ ...publisher, facetable: undefined }, schema).facet,
    ).toBeUndefined();
  });
});

describe('facet policy', () => {
  const place = (facetKeys: unknown) =>
    ({
      name: 'Place',
      class: 'urn:x:Place',
      facetKeys,
      fields: [],
    }) as unknown as SearchType;

  it('accepts a policy whose `only` is a function', () => {
    expect(validateSearchType(place({ only: () => true }))).toEqual([]);
  });

  it('rejects an `only` that is not a function', () => {
    // A declaration built outside TypeScript (a generator, plain JS) is what
    // this guards; a typed one cannot express it.
    expect(validateSearchType(place({ only: 'covered' }))).toEqual([
      { field: 'facetKeys', reason: 'facet-keys-only-not-a-function' },
    ]);
  });

  it('rejects a policy on a Reference Type, which nothing references by id', () => {
    const nested = {
      name: 'Marker',
      facetKeys: { only: () => true },
      fields: [],
    } as unknown as SearchType;
    expect(validateSearchType(nested)).toEqual([
      { field: 'facetKeys', reason: 'facet-keys-not-allowed' },
    ]);
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
      ref: { strategy: 'lookup', target: 'Agent' },
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

  it('finds the field declared over the indexed dataset, and none where there is none', () => {
    const declared: SearchField = {
      name: 'dataset',
      kind: 'reference',
      from: 'dataset',
      facetable: true,
      ref: { strategy: 'lookup', target: 'Dataset' },
    };
    const withDataset: SearchType = {
      name: 'Dataset',
      class: DATASET,
      fields: [...schema.fields, declared],
    };

    expect(datasetField(withDataset)).toBe(declared);
    // `schema` declares text/keyword/numeric fields but nothing over a
    // projection value.
    expect(datasetField(schema)).toBeUndefined();
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

describe('isAbsoluteIri', () => {
  it('accepts any scheme, not only http(s)', () => {
    // Restricting to http(s) would reject conformant Linked Data: URNs, DOIs,
    // ARKs and a deployment’s own minted scheme are all ordinary here.
    for (const iri of [
      'https://sws.geonames.org/2756308/',
      'http://example.org/x',
      'urn:uuid:0b7a1e1e-0000-4000-8000-000000000000',
      'urn:nbn:nl:ui:13-abcdef',
      'urn:lde:Dataset/publisherName',
      'doi:10.1234/5678',
      'ark:/61567/dataset',
      'tag:example.org,2026:x',
      'mailto:someone@example.org',
      'thing:abc123',
      'https://example.org/café', // an IRI is not restricted to ASCII
    ]) {
      expect(isAbsoluteIri(iri)).toBe(true);
    }
  });

  it('rejects what a reference must never hold', () => {
    for (const value of [
      '_:b0', // a blank node label – a scheme must start with a letter
      'boerenbont', // a bare token: the mistake this check exists to catch
      '/relative/path',
      '//example.org/x',
      'http://example.org/a b', // unencoded space
      'http://example.org/a\nb',
      '1nvalid:scheme',
      '',
    ]) {
      expect(isAbsoluteIri(value)).toBe(false);
    }
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

  it('rejects an unknown field kind', () => {
    // A typo’d kind in a plain-JS declaration must fail at declaration time –
    // every kind-dependent rule would silently pass for it otherwise.
    expect(
      validateSearchType(typeWith({ name: 'broken', kind: 'no-such-kind' })),
    ).toEqual([{ field: 'broken', reason: 'unknown-kind' }]);
  });

  it('rejects a field name carrying a regex metacharacter', () => {
    // The name is interpolated raw into the display RE2 pattern, so a
    // metacharacter would over-match or break the collection schema.
    expect(
      validateSearchType(typeWith({ name: 'v1.2', kind: 'keyword' })),
    ).toEqual([{ field: 'v1.2', reason: 'invalid-field-name' }]);
  });

  it('rejects a field named `id`, which every document already carries', () => {
    // The IRI is surfaced and filtered under that name for every type; a
    // declared `id` would shadow it and answer a different question. A domain
    // identifier belongs under its own name (e.g. `identifier`).
    expect(
      validateSearchType(typeWith({ name: 'id', kind: 'keyword' })),
    ).toEqual([{ field: 'id', reason: 'reserved-field-name' }]);
    expect(
      validateSearchType(typeWith({ name: 'identifier', kind: 'keyword' })),
    ).toEqual([]);
  });

  it('rejects a field named `and` or `or`, the reserved `where` combinators', () => {
    // Sibling keys in `where` already AND, so `or` is what makes a disjunction
    // expressible and `and` what carries a second one. A declared field of
    // either name would shadow the combinator and silently answer a different
    // question, exactly as a declared `id` would.
    expect(
      validateSearchType(typeWith({ name: 'and', kind: 'keyword' })),
    ).toEqual([{ field: 'and', reason: 'reserved-field-name' }]);
    expect(
      validateSearchType(typeWith({ name: 'or', kind: 'keyword' })),
    ).toEqual([{ field: 'or', reason: 'reserved-field-name' }]);
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

  it('requires a ref typeName on an inline reference alone', () => {
    // An `idOnly` reference emits no type of its own, so it needs no name to
    // emit one under – `sameAs` points at a vocabulary nobody indexes – and a
    // `lookup` derives its name from the `target` it already names. Only an
    // `inline` reference IS served as a separately named type, and without a
    // name the GraphQL surface prints `undefined` as the field's type: a
    // published contract that is not a schema. TypeScript's union already
    // forbids it, so this guards a declaration built outside it (plain JS, a
    // generator).
    expect(
      validateSearchType(
        typeWith({
          name: 'media',
          kind: 'reference',
          output: true,
          ref: { strategy: 'inline' },
        } as never),
      ),
    ).toEqual([{ field: 'media', reason: 'missing-ref-type-name' }]);

    // A lookup names its referent too – as `target`, the collection it reads
    // from. Without one it has nothing to read and nothing to emit.
    expect(
      validateSearchType(
        typeWith({
          name: 'creator',
          kind: 'reference',
          output: true,
          ref: { strategy: 'lookup' },
        } as never),
      ),
    ).toEqual([{ field: 'creator', reason: 'missing-ref-type-name' }]);

    expect(
      validateSearchType(
        typeWith({
          name: 'sameAs',
          kind: 'reference',
          output: true,
          ref: { strategy: 'idOnly' },
        }),
      ),
    ).toEqual([]);

    // Not surfaced, so nothing has to be emitted for it: a filter-only
    // reference falls back to the target-less IRI filter.
    expect(
      validateSearchType(
        typeWith({
          name: 'seeAlso',
          kind: 'reference',
          filterable: true,
          ref: { strategy: 'labelOnly' },
        } as never),
      ),
    ).toEqual([]);
  });

  it('rejects ref on a non-reference kind', () => {
    const type = typeWith({
      name: 'format',
      kind: 'keyword',
      ref: { strategy: 'lookup', target: 'Format' },
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

  it('accepts a reference declared over the indexed dataset', () => {
    expect(
      validateSearchType(
        typeWith({
          name: 'dataset',
          kind: 'reference',
          from: 'dataset',
          output: true,
          filterable: true,
          facetable: true,
          ref: { strategy: 'lookup', target: 'Dataset' },
        }),
      ),
    ).toEqual([]);
  });

  it('rejects a projection value the projection cannot supply', () => {
    expect(
      validateSearchType(
        typeWith({ name: 'run', kind: 'keyword', from: 'no-such-value' }),
      ),
    ).toEqual([{ field: 'run', reason: 'unknown-projection-value' }]);
  });

  it('allows from on keyword/reference only: the other kinds cannot hold an IRI', () => {
    expect(
      validateSearchType(
        typeWith({ name: 'dataset', kind: 'integer', from: 'dataset' }),
      ),
    ).toEqual([{ field: 'dataset', reason: 'from-not-allowed' }]);
  });

  it('rejects a field declaring from beside another value source', () => {
    expect(
      validateSearchType(
        typeWith(
          {
            name: 'fromPath',
            kind: 'reference',
            from: 'dataset',
            path: 'urn:dr:dataset',
          },
          {
            name: 'fromDerive',
            kind: 'keyword',
            from: 'dataset',
            derive: () => 'x',
          },
        ),
      ),
    ).toEqual([
      { field: 'fromPath', reason: 'from-with-path' },
      // The second field re-declares `dataset`, which no consumer could then
      // resolve to one declaration.
      { field: 'fromDerive', reason: 'duplicate-projection-value' },
      { field: 'fromDerive', reason: 'from-with-derive' },
    ]);
  });

  it('rejects a projection value carried by an inline reference', () => {
    // An inline reference is stored as a nested object; a projection value is a
    // bare IRI. Declared together, every document import would fail.
    expect(
      validateSearchType(
        typeWith({
          name: 'dataset',
          kind: 'reference',
          from: 'dataset',
          output: true,
          ref: { typeName: 'Dataset', strategy: 'inline' },
        }),
      ),
    ).toEqual([{ field: 'dataset', reason: 'from-with-inline-ref' }]);
  });

  it('rejects two fields over the same projection value', () => {
    expect(
      validateSearchType(
        typeWith(
          { name: 'dataset', kind: 'reference', from: 'dataset' },
          { name: 'sourceDataset', kind: 'keyword', from: 'dataset' },
        ),
      ),
    ).toEqual([
      { field: 'sourceDataset', reason: 'duplicate-projection-value' },
    ]);
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

  it('allows joinable on a reference field that declares a label source', () => {
    expect(
      validateSearchType(
        typeWith({
          name: 'publisher',
          kind: 'reference',
          filterable: true,
          labelSource: 'Organization',
          joinable: true,
        }),
      ),
    ).toEqual([]);
  });

  it('rejects joinable without a label source, and on a non-reference', () => {
    // A join addresses the referent’s COLLECTION, which is the one the label
    // source names; without one the flag states an edge to nowhere.
    expect(
      validateSearchType(
        typeWith({ name: 'publisher', kind: 'reference', joinable: true }),
      ),
    ).toEqual([
      { field: 'publisher', reason: 'joinable-without-label-source' },
    ]);
    expect(
      validateSearchType(
        typeWith({
          name: 'format',
          kind: 'keyword',
          joinable: true,
        } as never),
      ),
    ).toEqual([{ field: 'format', reason: 'joinable-not-allowed' }]);
  });

  it('counts joinable as a role, so such a field is never internal', () => {
    // An engine can only join through a value it stores, so a joinable
    // reference must survive the Internal Field pruning even when it declares
    // nothing else – otherwise the edge resolves and the query compiles
    // against a column the collection never had.
    const joinable: SearchField = {
      name: 'publisher',
      kind: 'reference',
      labelSource: 'Publisher',
      joinable: true,
    };
    expect(isInternalField(joinable)).toBe(false);
    // Without it, the same declaration is the reading device it looks like.
    expect(isInternalField({ ...joinable, joinable: false })).toBe(true);
  });

  it('rejects joinable on an inline reference', () => {
    // An inline reference is stored as a nested object, not as an id a
    // reference field can point at: the collection definition would emit the
    // nesting and silently drop the reference, so the join would validate,
    // compile, and only then fail at the engine.
    expect(
      validateSearchType(
        typeWith({
          name: 'media',
          kind: 'reference',
          output: true,
          labelSource: 'MediaObject',
          joinable: true,
          ref: { typeName: 'MediaObject', strategy: 'inline' },
        }),
      ),
    ).toEqual([{ field: 'media', reason: 'joinable-with-inline-ref' }]);
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

  describe('nested fields', () => {
    const datasetNesting = (ref: ReferenceStrategy) =>
      ({
        name: 'Dataset',
        class: DATASET,
        fields: [
          {
            name: 'media',
            kind: 'reference',
            array: true,
            output: true,
            path: 'https://schema.org/associatedMedia',
            ref,
          },
        ],
      }) as const;

    // The declaration under test is deliberately malformed in some cases, so
    // the overriding members are applied untyped and the whole cast back.
    const mediaObjectWith = (field: Record<string, unknown>): SearchType =>
      ({
        name: 'MediaObject',
        fields: [
          {
            name: 'contentUrl',
            kind: 'keyword',
            array: true,
            output: true,
            path: 'https://schema.org/contentUrl',
            ...field,
          },
        ],
      }) as SearchType;

    it('resolves the reference type a surfaced inline reference nests', () => {
      const dataset = datasetNesting({
        strategy: 'inline',
        typeName: 'MediaObject',
      });
      const mediaObject = mediaObjectWith({});
      const schema = searchSchema(dataset, mediaObject);
      expect(nestedReferenceType(schema, dataset.fields[0])).toEqual(
        mediaObject,
      );
    });

    it('nests nothing for a reading device or a non-inline reference', () => {
      // No Role: the reading device an inline reference is the other half of,
      // pruned before the writer rather than surfaced.
      const readingDevice = {
        name: 'Dataset',
        class: DATASET,
        fields: [
          {
            name: 'media',
            kind: 'reference',
            path: 'https://schema.org/associatedMedia',
            ref: { typeName: 'MediaObject', strategy: 'inline' },
          },
        ],
      } as const;
      const schema = searchSchema(readingDevice, mediaObjectWith({}));
      expect(
        nestedReferenceType(schema, readingDevice.fields[0]),
      ).toBeUndefined();
      // An idOnly reference carries the bare IRI, never the referent’s fields.
      const idOnly = datasetNesting({
        strategy: 'idOnly',
        typeName: 'MediaObject',
      });
      expect(
        nestedReferenceType(
          searchSchema(idOnly, mediaObjectWith({})),
          idOnly.fields[0],
        ),
      ).toBeUndefined();
    });

    it.each([
      ['searchable', { searchable: { weight: 1 } }],
      ['filterable', { filterable: true }],
      ['facetable', { facetable: true }],
      ['sortable', { sortable: true }],
    ])(
      'rejects a nested field declaring %s, naming the field',
      (role, declaration) => {
        // A nested field is stored with its referent and read back with it; it
        // never becomes an addressable field of its own, so any Role but
        // `output` would be silently ignored per query. Startup is where a
        // schema invariant fails.
        expect(() =>
          searchSchema(
            datasetNesting({ strategy: 'inline', typeName: 'MediaObject' }),
            mediaObjectWith(declaration),
          ),
        ).toThrow(
          new RegExp(
            `Nested field “MediaObject.contentUrl” declares “${role}”`,
          ),
        );
      },
    );

    it.each([
      ['searchable', { searchable: { weight: 1 } }],
      ['facetable', { facetable: true }],
    ])(
      'rejects an inline reference declaring %s alongside its nesting',
      (role, declaration) => {
        // An inline reference has exactly two jobs: a reading device (no Role)
        // or a surfaced nested object (`output`). Anything else would have an
        // engine search, facet, filter or sort on a nested document.
        expect(() =>
          searchSchema(
            {
              ...datasetNesting({
                strategy: 'inline',
                typeName: 'MediaObject',
              }),
              fields: [
                {
                  ...datasetNesting({
                    strategy: 'inline',
                    typeName: 'MediaObject',
                  }).fields[0],
                  ...declaration,
                },
              ],
            },
            mediaObjectWith({}),
          ),
        ).toThrow(
          new RegExp(`Inline reference “Dataset.media” declares “${role}”`),
        );
      },
    );

    it('names every unserviceable role a nested field declares', () => {
      expect(() =>
        searchSchema(
          datasetNesting({ strategy: 'inline', typeName: 'MediaObject' }),
          mediaObjectWith({ filterable: true, facetable: true }),
        ),
      ).toThrow(/“filterable”, “facetable”/);
    });

    it('rejects a label source on a nested field', () => {
      // Reconstruction runs no label lookup for a nested field, so a label
      // source there resolves nothing.
      expect(() =>
        searchSchema(
          datasetNesting({ strategy: 'inline', typeName: 'MediaObject' }),
          mediaObjectWith({
            kind: 'reference',
            labelSource: 'Organization',
            ref: { strategy: 'lookup', target: 'Organization' },
          }),
        ),
      ).toThrow(
        /Nested field “MediaObject.contentUrl” declares a label source/,
      );
    });

    it('rejects a lookup on a nested field', () => {
      // A lookup is resolved level by level from the hit's projection, and a
      // nested document is read back with its referent – so nothing would
      // resolve it, and every field of the emitted type would serve null.
      expect(() =>
        searchSchema(
          datasetNesting({ strategy: 'inline', typeName: 'MediaObject' }),
          mediaObjectWith({
            kind: 'reference',
            ref: { strategy: 'lookup', target: 'Organization' },
          }),
        ),
      ).toThrow(/Nested field “MediaObject.contentUrl” is a lookup/);
    });

    it('names the nested Physical Field of a referent’s field', () => {
      // The engine addresses a stored nested document by qualifying the
      // referent’s own field name with the reference that carries it.
      expect(nestedFieldName('media', 'contentUrl')).toBe('media.contentUrl');
      expect(nestedFieldName('media.thumbnail', 'label_nl')).toBe(
        'media.thumbnail.label_nl',
      );
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

    it('accepts a label source that names its own label field', () => {
      expect(() =>
        searchSchema(
          {
            name: 'Term',
            class: 'https://example.org/DefinedTerm',
            labelField: 'name',
            fields: [
              {
                name: 'name',
                kind: 'text',
                locales: ['und', 'nl'],
                output: true,
                searchable: { weight: 1 },
              },
            ],
          },
          {
            name: 'Dataset',
            class: DATASET,
            fields: [{ name: 'theme', kind: 'reference', labelSource: 'Term' }],
          },
        ),
      ).not.toThrow();
    });

    it('rejects a label source whose declared label field is missing, naming it', () => {
      expect(() =>
        searchSchema(
          { ...organization, labelField: 'name' },
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
      ).toThrow(/must declare an output, searchable text field “name”/);
    });

    it('names a Reference Type label source for what it is, not as unknown', () => {
      // The name IS declared, just not as a Root Type – so “declare a
      // SearchType with that name” would send an author looking in the wrong
      // place. Reachable only through a lookup: `labelSource` on a nested field
      // is rejected earlier, and a Reference Type carrying a label field is
      // rejected for being searchable.
      expect(() =>
        searchSchema(
          {
            name: 'AddressRef',
            fields: [{ name: 'street', kind: 'keyword', output: true }],
          },
          {
            name: 'Organization',
            class: 'https://example.org/Organization',
            fields: [
              {
                name: 'address',
                kind: 'reference',
                output: true,
                ref: { strategy: 'lookup', target: 'AddressRef' },
              },
            ],
          },
        ),
      ).toThrow(
        /names label source “AddressRef”, which is a Reference Type; a label source must be a Root Type/,
      );
    });

    it('rejects a Reference Type as a label source: it cannot be searchable', () => {
      // Why a label source is always a Root Type, and so always has a
      // collection to resolve from: a Reference Type carries `output` only.
      expect(() =>
        searchSchema(
          {
            name: 'Agent',
            fields: [
              {
                name: 'label',
                kind: 'text',
                locales: ['und'],
                output: true,
                searchable: { weight: 1 },
              },
            ],
          },
          {
            name: 'Dataset',
            class: DATASET,
            fields: [
              {
                name: 'publisher',
                kind: 'reference',
                labelSource: 'Agent',
              },
            ],
          },
        ),
      ).toThrow(/Nested field “Agent.label” declares “searchable”/);
    });

    it('reads the label source name off a lookup’s target and an idOnly’s labelSource', () => {
      expect(
        labelSourceNameOf({
          name: 'publisher',
          kind: 'reference',
          ref: { strategy: 'lookup', target: 'Organization' },
        }),
      ).toBe('Organization');
      expect(
        labelSourceNameOf({
          name: 'license',
          kind: 'reference',
          labelSource: 'Term',
          ref: { strategy: 'idOnly' },
        }),
      ).toBe('Term');
      // Resolves nothing: no target, no label source.
      expect(
        labelSourceNameOf({ name: 'license', kind: 'reference' }),
      ).toBeUndefined();
    });

    it('rejects a labelSource on anything but an idOnly reference', () => {
      expect(() =>
        searchSchema(organization, {
          name: 'Dataset',
          class: DATASET,
          fields: [
            {
              name: 'publisher',
              kind: 'reference',
              labelSource: 'Organization',
              ref: { strategy: 'lookup', target: 'Organization' },
            },
          ],
        }),
      ).toThrow(/declares a label source on a lookup reference/);
    });

    it('rejects a lookup whose target cannot serve labels', () => {
      expect(() =>
        searchSchema({
          name: 'Dataset',
          class: DATASET,
          fields: [
            {
              name: 'publisher',
              kind: 'reference',
              ref: { strategy: 'lookup', target: 'Organization' },
            },
          ],
        }),
      ).toThrow(/names unknown label source “Organization”/);
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

  it('reads an unpadded BCE year as a year, not as a UTC offset', () => {
    const seconds = isoToUnixSeconds('-1100');
    expect(unixSecondsToIso(seconds ?? 0)).toBe('-001100-01-01T00:00:00.000Z');
    expect(seconds).toBe(isoToUnixSeconds('-001100-01-01T00:00:00.000Z'));
  });

  it('reads a CE year beyond four digits, independent of the host timezone', () => {
    expect(unixSecondsToIso(isoToUnixSeconds('25000') ?? 0)).toBe(
      '+025000-01-01T00:00:00.000Z',
    );
    expect(unixSecondsToIso(isoToUnixSeconds('25000-06-01') ?? 0)).toBe(
      '+025000-06-01T00:00:00.000Z',
    );
  });

  it('leaves a plain four-digit year and an expanded one alone', () => {
    expect(unixSecondsToIso(isoToUnixSeconds('1999') ?? 0)).toBe(
      '1999-01-01T00:00:00.000Z',
    );
    expect(
      unixSecondsToIso(isoToUnixSeconds('+025000-01-01T00:00:00.000Z') ?? 0),
    ).toBe('+025000-01-01T00:00:00.000Z');
  });

  it('reads a deep-time BCE year beyond four digits', () => {
    expect(unixSecondsToIso(isoToUnixSeconds('-250000') ?? 0)).toBe(
      '-250000-01-01T00:00:00.000Z',
    );
    expect(unixSecondsToIso(isoToUnixSeconds('-38000') ?? 0)).toBe(
      '-038000-01-01T00:00:00.000Z',
    );
  });

  it('expands the year of a fuller BCE date, leaving the rest alone', () => {
    expect(unixSecondsToIso(isoToUnixSeconds('-1100-05-03') ?? 0)).toBe(
      '-001100-05-03T00:00:00.000Z',
    );
  });

  it('reads a whitespace-padded year as the year it spells', () => {
    // XSD collapses whitespace around a date literal, so a padded form is legal
    // and reaches the codec verbatim.
    for (const padded of [' -1100', '\t-1100', '-1100 ', '  -1100  ']) {
      expect(isoToUnixSeconds(padded)).toBe(isoToUnixSeconds('-1100'));
    }
    expect(isoToUnixSeconds(' 25000 ')).toBe(isoToUnixSeconds('25000'));
    expect(isoToUnixSeconds('  1999  ')).toBe(isoToUnixSeconds('1999'));
  });

  it('returns undefined for a year beyond what Date can represent', () => {
    // ±271,821 years is the edge of the Date range; past it there is no value
    // to store, so the field is left absent as an unparseable string is.
    expect(isoToUnixSeconds('-500000')).toBeUndefined();
    expect(isoToUnixSeconds('-271821')).toBeUndefined();
  });

  it('orders BCE before CE, and earlier BCE before later', () => {
    const deepTime = isoToUnixSeconds('-250000') ?? 0;
    const bce = isoToUnixSeconds('-1100') ?? 0;
    const ce = isoToUnixSeconds('1100') ?? 0;
    expect(deepTime).toBeLessThan(bce);
    expect(bce).toBeLessThan(ce);
  });
});

describe('key fields', () => {
  const SCHEMA_ORG = 'https://schema.org/';
  const GEONAMES = 'https://sws.geonames.org/';

  const sameAsField: SearchField = {
    name: '_sameAs',
    kind: 'reference',
    array: true,
    path: `<${SCHEMA_ORG}sameAs>`,
  };
  const nameField: SearchField = {
    name: 'name',
    kind: 'text',
    path: `<${SCHEMA_ORG}name>`,
    locales: ['und'],
    output: true,
    searchable: { weight: 1 },
  };
  /** A `Place` keyed on its alignment target, with an overridable key. */
  const keyedPlace = (key: RootType['key'] = { field: '_sameAs' }) =>
    ({
      name: 'Place',
      class: `${SCHEMA_ORG}Place`,
      labelField: 'name',
      key,
      fields: [nameField, sameAsField],
    }) as const satisfies SearchType;

  describe('declaration', () => {
    it('accepts a key naming a path-bearing, array, non-inline reference field', () => {
      expect(() => searchSchema(keyedPlace())).not.toThrow();
      expect(validateSearchType(keyedPlace())).toEqual([]);
    });

    it('rejects a key naming a field the type does not declare', () => {
      expect(validateSearchType(keyedPlace({ field: 'absent' }))).toEqual([
        { field: 'absent', reason: 'key-field-unknown' },
      ]);
    });

    it('rejects a key on a field that is not a reference', () => {
      // Candidates are IRIs, and the projection reads them as such.
      expect(validateSearchType(keyedPlace({ field: 'name' }))).toEqual([
        { field: 'name', reason: 'key-field-not-reference' },
      ]);
    });

    it('rejects a key field with no path: a key is read from the graph', () => {
      expect(
        validateSearchType({
          ...keyedPlace(),
          fields: [
            nameField,
            {
              name: '_sameAs',
              kind: 'reference',
              array: true,
              derive: () => [],
            },
          ],
        }),
      ).toEqual([{ field: '_sameAs', reason: 'key-field-without-path' }]);
    });

    it('rejects a single-valued key field: it would drop candidates unseen', () => {
      // A node may offer several; a single-valued field keeps the first,
      // whatever the CONSTRUCT’s order, so `pick` would never see the rest.
      expect(
        validateSearchType({
          ...keyedPlace(),
          fields: [nameField, { ...sameAsField, array: undefined }],
        }),
      ).toEqual([{ field: '_sameAs', reason: 'key-field-not-array' }]);
    });

    it('rejects an inline key field: it carries fields, not an IRI', () => {
      const marker: SearchType = {
        name: 'Marker',
        fields: [nameField],
      };
      const inlineKeyed: SearchType = {
        ...keyedPlace(),
        fields: [
          nameField,
          { ...sameAsField, ref: { strategy: 'inline', typeName: 'Marker' } },
        ],
      };
      expect(validateSearchType(inlineKeyed)).toEqual([
        { field: '_sameAs', reason: 'key-field-inline' },
      ]);
      expect(() => searchSchema(inlineKeyed, marker)).toThrow(
        /“_sameAs” \(key-field-inline\)/,
      );
    });

    it('rejects a pick that is not a function', () => {
      // A declaration built outside TypeScript (a generator, plain JS) is what
      // this guards; a typed one cannot express it.
      const key = { field: '_sameAs', pick: 'first' } as unknown as KeyField;
      expect(validateSearchType(keyedPlace(key))).toEqual([
        { field: '_sameAs', reason: 'key-pick-not-a-function' },
      ]);
    });

    it('rejects a key on a Reference Type, which is never keyed at all', () => {
      // Nested inside its referrer rather than keyed in a collection of its own.
      const nested = {
        name: 'Marker',
        key: { field: '_sameAs' },
        fields: [sameAsField],
      } as unknown as SearchType;
      expect(validateSearchType(nested)).toEqual([
        { field: '_sameAs', reason: 'key-not-allowed' },
      ]);
    });
  });

  describe('documentKeyOf', () => {
    it('keys on the node’s own IRI for a type that declares no key', () => {
      const unkeyed: RootType = {
        name: 'Place',
        class: `${SCHEMA_ORG}Place`,
        fields: [sameAsField],
      };
      expect(
        documentKeyOf(unkeyed, 'https://ex/place/1', [`${GEONAMES}1`]),
      ).toBe('https://ex/place/1');
    });

    it('defaults to the first candidate, sorted and deduplicated', () => {
      // Sorting is what makes the default deterministic whatever order the
      // CONSTRUCT returned the values in.
      const place = keyedPlace();
      expect(
        documentKeyOf(place, 'https://ex/place/1', [
          `${GEONAMES}2`,
          `${GEONAMES}1`,
          `${GEONAMES}1`,
        ]),
      ).toBe(`${GEONAMES}1`);
    });

    it('applies the key field’s transform, then filters non-IRIs', () => {
      const place = {
        ...keyedPlace(),
        fields: [
          nameField,
          {
            ...sameAsField,
            transform: (iri: string) => iri.replace(/\/$/, ''),
          },
        ],
      } as const satisfies SearchType;
      expect(
        documentKeyOf(place, 'https://ex/place/1', [
          'boerenbont',
          `${GEONAMES}1/`,
        ]),
      ).toBe(`${GEONAMES}1`);
    });

    it('keeps the node’s IRI when nothing survives, without consulting pick', () => {
      let consulted = false;
      const place = keyedPlace({
        field: '_sameAs',
        pick: (candidates) => {
          consulted = true;
          return candidates[0];
        },
      });

      expect(documentKeyOf(place, 'https://ex/place/1', ['_:b0'])).toBe(
        'https://ex/place/1',
      );
      expect(consulted).toBe(false);
    });

    it('keeps the node’s IRI when pick declines', () => {
      const place = keyedPlace({ field: '_sameAs', pick: () => undefined });
      expect(documentKeyOf(place, 'https://ex/place/1', [`${GEONAMES}1`])).toBe(
        'https://ex/place/1',
      );
    });

    it('throws when pick returns something no candidate offered', () => {
      const place = keyedPlace({
        field: '_sameAs',
        pick: () => 'https://elsewhere/1',
      });
      expect(() =>
        documentKeyOf(place, 'https://ex/place/1', [`${GEONAMES}1`]),
      ).toThrow(/is not among its candidates/);
    });
  });
});

describe('rootTypeNamed', () => {
  const place: SearchType = {
    name: 'Place',
    class: 'https://schema.org/Place',
    fields: [],
  };
  const marker: SearchType = { name: 'Marker', fields: [] };

  it('resolves a Root Type by the name a declaration points at', () => {
    expect(rootTypeNamed(searchSchema(place, marker), 'Place')).toBe(place);
  });

  it('resolves neither a Reference Type nor an undeclared name', () => {
    // The two name indexes are disjoint: `searchSchema` rejects a name twice.
    const schema = searchSchema(place, marker);
    expect(rootTypeNamed(schema, 'Marker')).toBeUndefined();
    expect(rootTypeNamed(schema, 'Absent')).toBeUndefined();
  });
});
