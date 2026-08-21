import { describe, expect, it } from 'vitest';
import { Parser } from 'n3';
import { dcat, dcterms, xsd } from '@tpluscode/rdf-ns-builders';
import {
  projectDocument,
  projectRoots,
  type SearchDocument,
} from '../src/project.js';
import {
  defineSearchType,
  searchSchema,
  type SearchField,
  type SearchType,
} from '../src/schema.js';

const DR = 'urn:dr:';
const IANA = 'https://www.iana.org/assignments/media-types/';
const DATASET = dcat.Dataset.value;

// The extraction CONSTRUCT emits each value under its field’s IR Alias
// (`urn:lde:‹Type›/‹field›`), and the projection reads it back under that key –
// never under the source `path`. Framed nodes here are therefore keyed by the
// alias, which is a function of the declaring type name and the field name.
const alias = (type: string, field: string) => `urn:lde:${type}/${field}`;
const dsKey = (field: string) => alias('Dataset', field);

const node = {
  '@id': 'https://ex/d/1',
  [dsKey('title')]: [
    { '@language': 'nl', '@value': 'Titel' },
    { '@language': 'en', '@value': 'Title' },
  ],
  [dsKey('publisher')]: { '@id': 'https://ex/o/1' },
  [dsKey('publisherName')]: { '@language': 'nl', '@value': 'Erfgoed' },
  [dsKey('keyword')]: [{ '@language': 'nl', '@value': 'Erfgoed' }],
  [dsKey('format')]: [`${IANA}text/turtle`],
  [dsKey('class')]: [{ '@id': 'http://schema.org/Person' }],
  [dsKey('date_posted')]: { '@value': '2024-01-01T00:00:00.000Z' },
  [dsKey('size')]: { '@type': xsd.integer.value, '@value': '1234' },
};

const fields: SearchField[] = [
  {
    name: 'title',
    path: dcterms.title.value,
    kind: 'text',
    locales: ['nl', 'en'],
    output: true,
    searchable: { weight: 1 },
    sortable: true,
  },
  {
    name: 'publisherName',
    path: `${DR}publisherName`,
    kind: 'text',
    locales: ['nl', 'en'],
    output: true,
    searchable: { weight: 1 },
  },
  {
    name: 'publisher',
    path: dcterms.publisher.value,
    kind: 'reference',
    facetable: true,
  },
  {
    name: 'keyword',
    path: dcat.keyword.value,
    kind: 'keyword',
    array: true,
    searchable: { weight: 1 },
  },
  {
    name: 'format',
    path: `${DR}format`,
    kind: 'keyword',
    array: true,
    facetable: true,
    transform: (value) => value.replace(IANA, ''),
  },
  {
    name: 'class',
    path: `${DR}class`,
    kind: 'reference',
    array: true,
    facetable: true,
  },
  {
    name: 'date_posted',
    path: `${DR}datePosted`,
    kind: 'date',
    sortable: true,
  },
  { name: 'size', path: `${DR}size`, kind: 'integer', facetable: true },
];

const schema: SearchType = {
  name: 'Dataset',
  class: DATASET,
  fields: [
    ...fields,
    {
      name: 'class_count',
      kind: 'integer',
      sortable: true,
      // Reads the `class` reference already projected into the document –
      // never the graph – so `path` stays the whole statement of what is read.
      derive: (document) =>
        (document.class as readonly string[] | undefined)?.length ?? 0,
    },
  ],
};

describe('projectDocument', () => {
  it('projects every field kind and computes derived fields', () => {
    const document = projectDocument(node, schema);

    expect(document.id).toBe('https://ex/d/1');
    expect(document.title_nl).toBe('Titel');
    expect(document.title_en).toBe('Title');
    expect(document.title_search_nl).toBe('titel');
    expect(document.title_search_en).toBe('title');
    expect(document.title_sort_nl).toBe('titel');
    expect(document.title_sort_en).toBe('title');
    expect(document.publisherName_nl).toBe('Erfgoed');
    expect(document.publisherName_search_nl).toBe('erfgoed');
    expect(document.publisherName_en).toBeUndefined();
    // Single-valued by declaration → the value itself, like every other kind.
    expect(document.publisher).toBe('https://ex/o/1');
    expect(document.keyword).toEqual(['Erfgoed']);
    expect(document.keyword_search).toEqual(['erfgoed']);
    expect(document.format).toEqual(['text/turtle']);
    expect(document.class).toEqual(['http://schema.org/Person']);
    expect(document.date_posted).toBe(
      Math.trunc(Date.parse('2024-01-01T00:00:00.000Z') / 1000),
    );
    expect(document.size).toBe(1234);
    expect(document.class_count).toBe(1);
  });

  it('coerces exotic JSON-LD value shapes', () => {
    const document = projectDocument(
      {
        '@id': 'https://ex/d/3',
        [dsKey('size')]: { '@value': 42 },
        [dsKey('language')]: { '@value': true },
        [dsKey('keyword')]: 'bareString',
        [dsKey('class')]: 'http://example.org/BareClass',
      },
      {
        name: 'Dataset',
        class: DATASET,
        fields: [
          {
            name: 'size',
            path: `${DR}size`,
            kind: 'integer',
            facetable: true,
          },
          {
            name: 'language',
            path: dcterms.language.value,
            kind: 'keyword',
            facetable: true,
          },
          {
            name: 'keyword',
            path: dcat.keyword.value,
            kind: 'keyword',
            searchable: { weight: 1 },
          },
          {
            name: 'class',
            path: `${DR}class`,
            kind: 'reference',
            facetable: true,
          },
        ],
      },
    );
    expect(document.size).toBe(42);
    expect(document.language).toBe('true');
    expect(document.keyword).toBe('bareString');
    expect(document.class).toBe('http://example.org/BareClass');
  });

  it('projects a number field as a float (not truncated like integer)', () => {
    const document = projectDocument(
      { '@id': 'https://ex/d/12', [dsKey('size')]: { '@value': '1234.5' } },
      {
        name: 'Dataset',
        class: DATASET,
        fields: [
          { name: 'size', path: `${DR}size`, kind: 'number', facetable: true },
        ],
      },
    );
    expect(document.size).toBe(1234.5);
  });

  it('projects a boolean field from a path (xsd:boolean lexical space)', () => {
    const withBoolean: SearchType = {
      name: 'Dataset',
      class: DATASET,
      fields: [
        { name: 'iiif', path: `${DR}iiif`, kind: 'boolean', facetable: true },
      ],
    };
    const project = (value: unknown): SearchDocument =>
      projectDocument(
        { '@id': 'https://ex/d/5', [dsKey('iiif')]: { '@value': value } },
        withBoolean,
      );

    expect(project('true').iiif).toBe(true);
    expect(project('1').iiif).toBe(true);
    expect(project('false').iiif).toBe(false);
    // Absent value → no field (the adapter reconstructs absence as false).
    expect(
      projectDocument({ '@id': 'https://ex/d/5' }, withBoolean).iiif,
    ).toBeUndefined();
  });

  it('stores a single-valued keyword or reference as the value, a declared array as a list', () => {
    // `array` decides the shape for these kinds exactly as it does for the
    // others: the graph may carry several values either way, and a
    // single-valued declaration takes the first – so the projection, the
    // engine collection definition (`string` vs `string[]`) and the API output
    // type all describe one declaration the same way.
    const document = projectDocument(
      {
        '@id': 'https://ex/d/shape',
        [dsKey('format')]: [`${IANA}text/turtle`, `${IANA}application/ld+json`],
        [dsKey('class')]: [
          { '@id': 'http://schema.org/Person' },
          { '@id': 'http://schema.org/Place' },
        ],
      },
      {
        name: 'Dataset',
        class: DATASET,
        fields: [
          {
            name: 'format',
            path: `${DR}format`,
            kind: 'keyword',
            facetable: true,
            searchable: { weight: 1 },
            transform: (value) => value.replace(IANA, ''),
          },
          {
            name: 'class',
            path: `${DR}class`,
            kind: 'reference',
            array: true,
            facetable: true,
          },
        ],
      },
    );

    expect(document.format).toBe('text/turtle');
    expect(document.format_search).toBe('text/turtle');
    expect(document.class).toEqual([
      'http://schema.org/Person',
      'http://schema.org/Place',
    ]);
  });

  it('drops a reference value that is not an absolute IRI', () => {
    // What a labelOnly/idOnly reference stores is a SELECTION KEY, and a blank
    // node label is not one: framing mints it per call, so it recurs across
    // documents and changes when unrelated triples do – a facet bucket keyed on
    // it would neither group what is equal nor separate what is not. The same
    // rule documentKey applies to a root, so the two cannot disagree about what
    // counts as identity.
    const document = projectDocument(
      {
        '@id': 'https://ex/d/blank-referent',
        [dsKey('class')]: [
          { '@id': 'http://schema.org/Person' },
          { '@id': '_:b0' },
          { '@id': '/relative' },
          'boerenbont',
          { '@id': 'urn:example:ok' },
        ],
      },
      {
        name: 'Dataset',
        class: DATASET,
        fields: [
          {
            name: 'class',
            path: `${DR}class`,
            kind: 'reference',
            array: true,
            facetable: true,
          },
        ],
      },
    );

    expect(document.class).toEqual([
      'http://schema.org/Person',
      'urn:example:ok',
    ]);
  });

  it('folds the transformed values (not the raw ones) for a facet search field', () => {
    const document = projectDocument(
      { '@id': 'https://ex/d/4', [dsKey('format')]: [`${IANA}text/turtle`] },
      {
        name: 'Dataset',
        class: DATASET,
        fields: [
          {
            name: 'format',
            path: `${DR}format`,
            kind: 'keyword',
            array: true,
            searchable: { weight: 1 },
            transform: (value) => value.replace(IANA, ''),
          },
        ],
      },
    );
    expect(document.format).toEqual(['text/turtle']);
    expect(document.format_search).toEqual(['text/turtle']);
  });

  it('omits absent optional fields', () => {
    const document = projectDocument(
      {
        '@id': 'https://ex/d/2',
        [dsKey('title')]: { '@language': 'nl', '@value': 'Solo' },
      },
      { name: 'Dataset', class: DATASET, fields },
    );
    expect(document.id).toBe('https://ex/d/2');
    expect(document.title_search_nl).toBe('solo');
    expect(document.publisher).toBeUndefined();
    expect(document.size).toBeUndefined();
  });

  it('omits the sort field when there is no value to sort on', () => {
    const document = projectDocument(
      { '@id': 'https://ex/d/5' },
      { name: 'Dataset', class: DATASET, fields },
    );
    expect(document.id).toBe('https://ex/d/5');
    expect(document.title_sort_nl).toBeUndefined();
  });

  it('displays a value whose language is outside locales, but does not index it', () => {
    const document = projectDocument(
      {
        '@id': 'https://ex/d/6',
        [dsKey('title')]: { '@language': 'fr', '@value': 'Bonjour' },
      },
      { name: 'Dataset', class: DATASET, fields },
    );
    // locales is ['nl', 'en']; the French title still renders (display keeps
    // every language, `index: false`), but it is not searched or sorted – those
    // stay on the declared locales.
    expect(document.title_fr).toBe('Bonjour');
    expect(document.title_nl).toBeUndefined();
    expect(document.title_en).toBeUndefined();
    expect(document.title_search_nl).toBeUndefined();
    expect(document.title_search_fr).toBeUndefined();
    expect(document.title_sort_nl).toBeUndefined();
  });

  it('normalises an underscore-style language tag to its BCP-47 shape', () => {
    const document = projectDocument(
      {
        '@id': 'https://ex/d/6b',
        // Non-conformant `pt_BR` (underscore instead of hyphen) – dirty data.
        [dsKey('title')]: { '@language': 'pt_BR', '@value': 'Mapa' },
      },
      { name: 'Dataset', class: DATASET, fields },
    );
    // Normalised to `pt-BR`, so the display key is underscore-free and both the
    // regex collection field and displayLangOf round-trip it (rather than the
    // value being silently dropped).
    expect(document['title_pt-BR']).toBe('Mapa');
    expect(document.title_pt_BR).toBeUndefined();
  });

  it('displays an untagged literal under und, but does not index it when und is undeclared', () => {
    const document = projectDocument(
      {
        '@id': 'https://ex/d/7',
        [dsKey('title')]: { '@value': 'Naamloos' },
      },
      { name: 'Dataset', class: DATASET, fields },
    );
    // Untagged lands in the `und` display bucket; locales is ['nl', 'en'] (no
    // `und`), so it is not searched.
    expect(document.title_und).toBe('Naamloos');
    expect(document.title_nl).toBeUndefined();
    expect(document.title_search_und).toBeUndefined();
    expect(document.title_en).toBeUndefined();
  });

  it('emits only the families a field opts into (search-only: no display)', () => {
    const document = projectDocument(
      {
        '@id': 'https://ex/d/10',
        [dsKey('title')]: { '@language': 'nl', '@value': 'Verhalen' },
      },
      {
        name: 'Dataset',
        class: DATASET,
        fields: [
          {
            name: 'title',
            path: dcterms.title.value,
            // search only – display (output) and sort not opted into.
            kind: 'text',
            locales: ['nl', 'en'],
            searchable: { weight: 1 },
          },
        ],
      },
    );
    // Search field is emitted; the per-locale display label is not.
    expect(document.title_search_nl).toBe('verhalen');
    expect(document.title_nl).toBeUndefined();
    expect(document.title_sort_nl).toBeUndefined();
  });

  it('emits display and sort but no search for a sort-only output field', () => {
    const document = projectDocument(
      {
        '@id': 'https://ex/d/10b',
        [dsKey('title')]: [
          { '@language': 'nl', '@value': 'Verhalen' },
          { '@language': 'fr', '@value': 'Récits' },
        ],
      },
      {
        name: 'Dataset',
        class: DATASET,
        fields: [
          {
            name: 'title',
            path: dcterms.title.value,
            kind: 'text',
            locales: ['nl', 'en'],
            output: true,
            // display + sort, but not searchable.
            sortable: true,
          },
        ],
      },
    );
    // Display keeps both languages (fr outside locales); sort stays on nl; no
    // folded search field is emitted at all.
    expect(document.title_nl).toBe('Verhalen');
    expect(document.title_fr).toBe('Récits');
    expect(document.title_sort_nl).toBe('verhalen');
    expect(document.title_search_nl).toBeUndefined();
  });

  it('folds every value of a locale into its search field', () => {
    const document = projectDocument(
      {
        '@id': 'https://ex/d/8',
        [dsKey('title')]: [
          { '@language': 'nl', '@value': 'Titel' },
          { '@language': 'nl', '@value': 'Ondertitel' },
        ],
      },
      { name: 'Dataset', class: DATASET, fields },
    );
    // Display takes the first value; search folds them all so both are matchable.
    expect(document.title_nl).toBe('Titel');
    expect(document.title_search_nl).toBe('titel ondertitel');
  });

  it('computes a derived field via derive, which may read earlier fields', () => {
    const document = projectDocument(
      {
        '@id': 'https://ex/d/11',
        [dsKey('title')]: { '@language': 'nl', '@value': 'Titel' },
      },
      {
        name: 'Dataset',
        class: DATASET,
        fields: [
          {
            name: 'title',
            path: dcterms.title.value,
            kind: 'text',
            locales: ['nl'],
            output: true,
          },
          // No `path`: a derived field – computed by `derive`, never
          // projected.
          {
            name: 'status',
            kind: 'keyword',
            facetable: true,
            derive: () => 'valid',
          },
          // Runs after `status` (declaration order), so it can read it.
          {
            name: 'statusRank',
            kind: 'integer',
            sortable: true,
            derive: (document) => (document.status === 'valid' ? 1 : 0),
          },
          // Returning undefined leaves the field absent.
          { name: 'absent', kind: 'keyword', derive: () => undefined },
          // Neither path nor derive: populated outside the projection, if at
          // all – skipped here.
          { name: 'external', kind: 'keyword' },
        ],
      },
    );
    expect(document.title_nl).toBe('Titel');
    expect(document.status).toBe('valid');
    expect(document.statusRank).toBe(1);
    expect(document).not.toHaveProperty('absent');
    expect(document).not.toHaveProperty('external');
  });

  it('applies the date storage codec to a derived date, as it does to a read one', () => {
    const document = projectDocument(
      { '@id': 'https://ex/d/12' },
      {
        name: 'Dataset',
        class: DATASET,
        fields: [
          // A derive returning an ISO string is converted, so it cannot land a
          // string in a field the collection declares int64.
          {
            name: 'issued',
            kind: 'date',
            sortable: true,
            derive: () => '2024-01-01T00:00:00.000Z',
          },
          // A derive that already computed seconds passes through untouched.
          {
            name: 'modified',
            kind: 'date',
            sortable: true,
            derive: () => 1_704_067_200,
          },
          // An unparseable string leaves the field absent, exactly as a derive
          // returning `undefined` does.
          { name: 'created', kind: 'date', derive: () => 'not-a-date' },
          // …and so does a derive that computed its own seconds from an
          // unparseable input, rather than shipping NaN into an int64 field.
          {
            name: 'available',
            kind: 'date',
            derive: () => Date.parse('not-a-date') / 1000,
          },
          // Seconds past what `Date` can represent are dropped too: stored,
          // they read back as an error at the surface rather than as a value,
          // where an unparseable string simply leaves the field absent.
          {
            name: 'temporal',
            kind: 'date',
            derive: () => -8_640_000_000_001,
          },
        ],
      },
    );
    expect(document.issued).toBe(1_704_067_200);
    expect(document.modified).toBe(1_704_067_200);
    expect(document).not.toHaveProperty('created');
    expect(document).not.toHaveProperty('available');
    expect(document).not.toHaveProperty('temporal');
  });

  it('holds a reference to absolute IRIs on every route a value can arrive by', () => {
    // `iriString` guards the graph path, but three routes bypass it: a
    // `derive`, a `from` projection value, and a `transform` that runs after
    // the path was checked. The surface types all of them `IRI`, so all of them
    // are guarded – otherwise the API promises identity over a value the
    // projection let through, and the outbound error blames a stale index for
    // something a live declaration produced.
    const document = projectDocument(
      {
        '@id': 'https://ex/d/12',
        [dsKey('title')]: { '@id': 'https://ex/term/1' },
      },
      {
        name: 'Dataset',
        class: DATASET,
        fields: [
          // ADR 21 sends IRI-valued keyword derives here; a returned non-IRI is
          // dropped, exactly as the graph path drops one.
          {
            name: 'derived',
            kind: 'reference',
            array: true,
            filterable: true,
            // A bare token, a blank-node label and a non-string all fail the
            // rule; only the IRI is a selection key.
            derive: () => ['https://ex/org/1', 'boerenbont', '_:b0', 42],
          },
          {
            name: 'derivedSingle',
            kind: 'reference',
            filterable: true,
            derive: () => 'not-an-iri',
          },
          {
            name: 'derivedNonString',
            kind: 'reference',
            filterable: true,
            derive: () => 42,
          },
          {
            name: 'derivedSingleValid',
            kind: 'reference',
            filterable: true,
            derive: () => 'https://ex/org/2',
          },
          // A `from` projection value never passes `iriString` at all.
          {
            name: 'fromContext',
            kind: 'reference',
            filterable: true,
            from: 'dataset',
          },
          // A transform runs after the path was validated, so it can undo it.
          {
            name: 'sameAs',
            kind: 'reference',
            array: true,
            path: dcterms.title.value,
            filterable: true,
            transform: (value) => value.replace('https://ex/term/', ''),
          },
        ],
      },
      undefined,
      { dataset: 'not-an-iri' },
    );
    expect(document.derived).toEqual(['https://ex/org/1']);
    expect(document).not.toHaveProperty('derivedSingle');
    expect(document).not.toHaveProperty('derivedNonString');
    expect(document.derivedSingleValid).toBe('https://ex/org/2');
    expect(document.fromContext).toBeUndefined();
    // Every transformed value fails the rule, so the field is left absent –
    // the same outcome the graph path gives a reference it cannot key on.
    expect(document).not.toHaveProperty('sameAs');
  });

  it('prunes an internal (zero-role) field of every non-text kind from the document', () => {
    const document = projectDocument(
      {
        '@id': 'https://ex/d/internal',
        [dsKey('token')]: ['tok'],
        [dsKey('ref')]: { '@id': 'https://ex/o/9' },
        [dsKey('count')]: { '@value': '7' },
        [dsKey('score')]: { '@value': '1.5' },
        [dsKey('flag')]: { '@value': 'true' },
      },
      {
        name: 'Dataset',
        class: DATASET,
        fields: [
          { name: 'token', path: `${DR}token`, kind: 'keyword' },
          { name: 'ref', path: `${DR}ref`, kind: 'reference' },
          { name: 'count', path: `${DR}count`, kind: 'integer' },
          { name: 'score', path: `${DR}score`, kind: 'number' },
          { name: 'flag', path: `${DR}flag`, kind: 'boolean' },
        ],
      },
    );
    // Each field declares no role, so it is internal: projected then pruned.
    // The document a writer sees carries only its id – it reaches neither a
    // writer nor the collection definition.
    expect(document).toEqual({ id: 'https://ex/d/internal' });
  });

  it('projects an internal field so a later derive reads it, then prunes the internal field', () => {
    const document = projectDocument(
      {
        '@id': 'https://ex/d/reading-device',
        [dsKey('classes')]: [
          { '@id': 'http://schema.org/Person' },
          { '@id': 'http://schema.org/Place' },
        ],
      },
      {
        name: 'Dataset',
        class: DATASET,
        fields: [
          // An internal reading device: a reference with no role, projected so
          // the derive below can read it, pruned before the writer sees it.
          {
            name: 'classes',
            path: `${DR}class`,
            kind: 'reference',
            array: true,
          },
          {
            name: 'classCount',
            kind: 'integer',
            facetable: true,
            derive: (document) =>
              (document.classes as readonly string[] | undefined)?.length ?? 0,
          },
        ],
      },
    );
    // The derive read the internal field’s value…
    expect(document.classCount).toBe(2);
    // …but the internal field itself never reaches the writer.
    expect(document).not.toHaveProperty('classes');
  });

  it('flattens an inline reading-device reference with a derive, then prunes it', () => {
    // The reading device (ADR 11): an inline reference declaring no role is an
    // internal field. Its referent’s fields are projected so a derive can select
    // and flatten a value a path cannot address; the internal field is pruned
    // before the writer sees it.
    const registration = defineSearchType({
      name: 'Registration',
      fields: [
        { name: 'dateRead', kind: 'date', path: 'https://schema.org/dateRead' },
        {
          name: 'datePosted',
          kind: 'date',
          path: 'https://schema.org/datePosted',
        },
      ],
    });
    const dataset = defineSearchType({
      name: 'Dataset',
      class: DATASET,
      fields: [
        {
          name: 'registration',
          kind: 'reference',
          array: true,
          path: `${DR}registration`,
          ref: { typeName: 'Registration', strategy: 'inline' },
        },
        {
          name: 'datePosted',
          kind: 'date',
          output: true,
          // Select the newest registration by dateRead, flatten its datePosted.
          derive: (document) => {
            const registrations =
              (document.registration as
                | readonly { dateRead?: number; datePosted?: number }[]
                | undefined) ?? [];
            return [...registrations].sort(
              (left, right) => (right.dateRead ?? 0) - (left.dateRead ?? 0),
            )[0]?.datePosted;
          },
        },
      ],
    });
    const withReference = searchSchema(dataset, registration);

    const document = projectDocument(
      {
        '@id': 'https://ex/d/reg',
        [dsKey('registration')]: [
          {
            '@id': 'https://ex/r/1',
            [alias('Registration', 'dateRead')]: {
              '@value': '2024-01-01T00:00:00Z',
            },
            [alias('Registration', 'datePosted')]: {
              '@value': '2024-02-01T00:00:00Z',
            },
          },
          {
            '@id': 'https://ex/r/2',
            [alias('Registration', 'dateRead')]: {
              '@value': '2024-06-01T00:00:00Z',
            },
            [alias('Registration', 'datePosted')]: {
              '@value': '2024-07-01T00:00:00Z',
            },
          },
        ],
      },
      dataset,
      withReference,
    );

    // The derive read the newest registration (r/2, read 2024-06) and flattened
    // its datePosted (2024-07)…
    expect(document.datePosted).toBe(
      Math.trunc(Date.parse('2024-07-01T00:00:00Z') / 1000),
    );
    // …and the internal inline reference itself never reaches the writer.
    expect(document).not.toHaveProperty('registration');
  });

  it('leaves an inline reference absent when the node carries no referent', () => {
    const registration = defineSearchType({
      name: 'Registration',
      fields: [
        { name: 'dateRead', kind: 'date', path: 'https://schema.org/dateRead' },
      ],
    });
    const dataset = defineSearchType({
      name: 'Dataset',
      class: DATASET,
      fields: [
        {
          name: 'registration',
          kind: 'reference',
          array: true,
          output: true,
          path: `${DR}registration`,
          ref: { typeName: 'Registration', strategy: 'inline' },
        },
      ],
    });
    const withReference = searchSchema(dataset, registration);
    const document = projectDocument(
      { '@id': 'https://ex/d/empty' },
      dataset,
      withReference,
    );
    expect(document).toEqual({ id: 'https://ex/d/empty' });
  });

  it('projects nothing for an inline reference when no schema is supplied', () => {
    // An inline reference is a nested structure that can only be resolved with a
    // schema; projected without one, it must not fall through to a bare-IRI
    // facet under its own name.
    const dataset: SearchType = {
      name: 'Dataset',
      class: DATASET,
      fields: [
        {
          name: 'registration',
          kind: 'reference',
          output: true,
          path: `${DR}registration`,
          ref: { typeName: 'Registration', strategy: 'inline' },
        },
      ],
    };
    const document = projectDocument(
      {
        '@id': 'https://ex/d/noschema',
        [dsKey('registration')]: { '@id': 'https://ex/r/1' },
      },
      dataset,
    );
    expect(document).toEqual({ id: 'https://ex/d/noschema' });
  });

  it('nests nothing for a value an inline reference cannot read as a referent', () => {
    // A referent needs no identity, but it does need fields: a literal under the
    // reference’s alias (dirty source data), or a node the reference type reads
    // nothing from, projects no field at all. Nesting an empty document would
    // hand the writer a content-free referent – and, for a single-valued
    // reference, let it win the slot over a real referent behind it.
    const creator = defineSearchType({
      name: 'Creator',
      fields: [
        {
          name: 'label',
          kind: 'text',
          path: 'https://schema.org/name',
          locales: ['nl'],
          output: true,
        },
      ],
    });
    const dataset = defineSearchType({
      name: 'Dataset',
      class: DATASET,
      fields: [
        {
          name: 'creator',
          kind: 'reference',
          output: true,
          path: `${DR}creator`,
          ref: { typeName: 'Creator', strategy: 'inline' },
        },
      ],
    });
    const withReference = searchSchema(dataset, creator);

    const document = projectDocument(
      {
        '@id': 'https://ex/d/literal',
        [dsKey('creator')]: [
          { '@value': 'Jan Jansen' },
          {
            '@id': 'https://ex/c/3',
            [alias('Creator', 'label')]: {
              '@language': 'nl',
              '@value': 'Naam',
            },
          },
        ],
      },
      dataset,
      withReference,
    );

    // The literal contributed no referent, so the real one takes the slot.
    expect(document.creator).toEqual({
      id: 'https://ex/c/3',
      label_nl: 'Naam',
    });
  });

  it('skips an inline reference the given schema does not declare', () => {
    // projectDocument does not check type membership (projectRoots does); framed
    // against a schema that omits the referent, an inline reference contributes
    // no nesting rather than throwing.
    const dataset = defineSearchType({
      name: 'Dataset',
      class: DATASET,
      fields: [
        {
          name: 'registration',
          kind: 'reference',
          output: true,
          path: `${DR}registration`,
          ref: { typeName: 'Registration', strategy: 'inline' },
        },
      ],
    });
    const foreignSchema = searchSchema({
      name: 'Other',
      class: 'urn:other',
      fields: [],
    });
    const document = projectDocument(
      {
        '@id': 'https://ex/d/foreign',
        [dsKey('registration')]: { '@id': 'https://ex/r/9' },
      },
      dataset,
      foreignSchema,
    );
    expect(document).not.toHaveProperty('registration');
  });

  it('surfaces an inline output reference as a nested document (API device)', () => {
    const creator = defineSearchType({
      name: 'Creator',
      fields: [
        {
          name: 'label',
          kind: 'text',
          path: 'https://schema.org/name',
          locales: ['nl'],
          output: true,
        },
      ],
    });
    const dataset = defineSearchType({
      name: 'Dataset',
      class: DATASET,
      fields: [
        {
          name: 'creator',
          kind: 'reference',
          output: true,
          path: `${DR}creator`,
          ref: { typeName: 'Creator', strategy: 'inline' },
        },
      ],
    });
    const withReference = searchSchema(dataset, creator);

    const document = projectDocument(
      {
        '@id': 'https://ex/d/api',
        [dsKey('creator')]: {
          '@id': 'https://ex/c/1',
          [alias('Creator', 'label')]: { '@language': 'nl', '@value': 'Naam' },
        },
      },
      dataset,
      withReference,
    );

    // An output inline reference surfaces its referent as a nested Search
    // Document (its Reference Type’s projected fields), not a bare IRI.
    expect(document.creator).toEqual({
      id: 'https://ex/c/1',
      label_nl: 'Naam',
    });
  });

  it('prunes an internal helper field from a surfaced (output) inline referent, after a derive reads it', () => {
    // A Reference Type may carry an internal helper field – no role – that its
    // own derive reads. When the reference is surfaced (`output`), the invariant
    // *a field without a role reaches neither the engine nor the API* must still
    // hold inside the nested document: the helper is projected (so the derive
    // reads it) then pruned, while the derived output field survives.
    const creator = defineSearchType({
      name: 'Creator',
      fields: [
        {
          name: 'label',
          kind: 'text',
          path: 'https://schema.org/name',
          locales: ['nl'],
          output: true,
        },
        // Internal helper: no role, read by the derive below, pruned from the
        // surfaced referent.
        {
          name: 'rawSort',
          kind: 'keyword',
          path: 'https://schema.org/alternateName',
        },
        {
          name: 'sortLabel',
          kind: 'keyword',
          output: true,
          derive: (referent) => referent.rawSort as string | undefined,
        },
      ],
    });
    const dataset = defineSearchType({
      name: 'Dataset',
      class: DATASET,
      fields: [
        {
          name: 'creator',
          kind: 'reference',
          array: true,
          output: true,
          path: `${DR}creator`,
          ref: { typeName: 'Creator', strategy: 'inline' },
        },
      ],
    });
    const withReference = searchSchema(dataset, creator);

    const document = projectDocument(
      {
        '@id': 'https://ex/d/prune',
        [dsKey('creator')]: [
          {
            '@id': 'https://ex/c/2',
            [alias('Creator', 'label')]: {
              '@language': 'nl',
              '@value': 'Naam',
            },
            [alias('Creator', 'rawSort')]: 'Alt',
          },
        ],
      },
      dataset,
      withReference,
    );

    const [referent] = document.creator as SearchDocument[];
    // The derive read the helper (sortLabel carries its value)…
    expect(referent).toMatchObject({
      id: 'https://ex/c/2',
      label_nl: 'Naam',
      sortLabel: 'Alt',
    });
    // …but the internal helper itself never surfaces in the nested document.
    expect(referent).not.toHaveProperty('rawSort');
  });

  it('never keys a nested document by a blank node label', () => {
    // Framing prunes a blank node identifier that occurs once, but keeps it when
    // the same referent is referenced twice. That label is minted per framing
    // call: it recurs across documents and changes when unrelated triples do, so
    // it is never a document key – the referent keeps its fields and no `id`,
    // exactly as when framing pruned the label.
    const creator = defineSearchType({
      name: 'Creator',
      fields: [
        {
          name: 'label',
          kind: 'text',
          path: 'https://schema.org/name',
          locales: ['nl'],
          output: true,
        },
      ],
    });
    const dataset = defineSearchType({
      name: 'Dataset',
      class: DATASET,
      fields: [
        {
          name: 'creator',
          kind: 'reference',
          output: true,
          path: `${DR}creator`,
          ref: { typeName: 'Creator', strategy: 'inline' },
        },
      ],
    });

    const document = projectDocument(
      {
        '@id': 'https://ex/d/blank',
        [dsKey('creator')]: {
          '@id': '_:b0',
          [alias('Creator', 'label')]: { '@language': 'nl', '@value': 'Naam' },
        },
      },
      dataset,
      searchSchema(dataset, creator),
    );

    expect(document.creator).toEqual({ label_nl: 'Naam' });
  });

  it('buckets untagged literals into the reserved und locale', () => {
    const document = projectDocument(
      {
        '@id': 'https://ex/d/13',
        [dsKey('title')]: [
          { '@language': 'nl', '@value': 'Café' },
          'Untagged subtitle',
        ],
        // `note` reads dcterms:title too, so the extraction emits the value under
        // its own alias as well – each field gets its own IR Alias, even when two
        // share a source path.
        [dsKey('note')]: [
          { '@language': 'nl', '@value': 'Café' },
          'Untagged subtitle',
        ],
      },
      {
        name: 'Dataset',
        class: DATASET,
        fields: [
          {
            name: 'title',
            path: dcterms.title.value,
            kind: 'text',
            locales: ['nl', 'und'],
            output: true,
            sortable: true,
            searchable: { weight: 3 },
          },
          // No values at this path: nothing is emitted.
          {
            name: 'subtitle',
            path: 'urn:dr:none',
            kind: 'text',
            locales: ['und'],
            output: true,
          },
          // Search-only: folded companions, no display values.
          {
            name: 'note',
            path: dcterms.title.value,
            kind: 'text',
            locales: ['und'],
            searchable: { weight: 1 },
          },
        ],
      },
    );
    // Display keeps accents, one value per locale bucket.
    expect(document.title_nl).toBe('Café');
    expect(document.title_und).toBe('Untagged subtitle');
    expect(document.title_search_nl).toBe('cafe');
    expect(document.title_search_und).toBe('untagged subtitle');
    expect(document.title_sort_und).toBe('untagged subtitle');
    expect(document).not.toHaveProperty('subtitle_und');
    expect(document).not.toHaveProperty('note_und');
    expect(document.note_search_und).toBe('untagged subtitle');
  });

  it('ignores IR values it cannot read (non-literal @value, node without @id)', () => {
    const document = projectDocument(
      {
        '@id': 'https://ex/d/12',
        [dsKey('title')]: [
          { '@language': 'nl', '@value': 'Titel' },
          { '@language': 'nl', '@value': { nested: true } },
        ],
        [dsKey('keyword')]: [{ '@value': { nested: true } }, 'kaart'],
        [dsKey('publisher')]: [{ nested: true }, { '@id': 'https://o/1' }],
      },
      {
        name: 'Dataset',
        class: DATASET,
        fields: [
          {
            name: 'title',
            path: dcterms.title.value,
            kind: 'text',
            locales: ['nl'],
            output: true,
          },
          {
            name: 'keyword',
            path: dcat.keyword.value,
            kind: 'keyword',
            facetable: true,
          },
          {
            name: 'publisher',
            path: dcterms.publisher.value,
            kind: 'reference',
            facetable: true,
          },
        ],
      },
    );
    expect(document.title_nl).toBe('Titel');
    expect(document.keyword).toBe('kaart');
    expect(document.publisher).toBe('https://o/1');
  });

  it('throws when the framed node has no @id', () => {
    expect(() =>
      projectDocument(
        { [dsKey('title')]: { '@value': 'No id' } },
        { name: 'Dataset', class: DATASET, fields },
      ),
    ).toThrow(/@id is not an absolute IRI/);
  });

  it('throws when the framed node is keyed by a blank node label', () => {
    // A blank node has no stable document key: `_:b0` is minted per framing
    // call. A root bearing one is as keyless as one carrying no `@id` at all,
    // and must be rejected rather than emitted under an unstable id.
    expect(() =>
      projectDocument(
        { '@id': '_:b0' },
        {
          name: 'Dataset',
          class: DATASET,
          fields,
        },
      ),
    ).toThrow(/@id is not an absolute IRI/);
  });

  it('projects nothing for a localized field with no locales (rejected at declaration time)', () => {
    // validateSearchType owns the empty-locales rule; the projection itself
    // stays total for hand-built maps that bypassed searchSchema().
    const document = projectDocument(
      {
        '@id': 'https://ex/d/9',
        [dsKey('title')]: { '@language': 'nl', '@value': 'Titel' },
      },
      {
        name: 'Dataset',
        class: DATASET,
        fields: [
          {
            name: 'title',
            path: dcterms.title.value,
            kind: 'text',
            locales: [],
          },
        ],
      },
    );
    expect(document).toEqual({ id: 'https://ex/d/9' });
  });
});

describe('projectRoots', () => {
  const dataset = defineSearchType({ name: 'Dataset', class: DATASET, fields });
  const schema = searchSchema(dataset);

  it('projects exactly the given roots, without any rdf:type', async () => {
    // No type triples: the roots are supplied by the caller (the selector).
    const quads = new Parser({ format: 'N-Triples' }).parse(`
      <https://ex/d/1> <${dsKey('title')}> "Titel"@nl .
      <https://ex/d/2> <${dsKey('title')}> "Andere"@nl .
    `);

    const documents: SearchDocument[] = [];
    for await (const document of projectRoots(
      quads,
      ['https://ex/d/1', 'https://ex/d/2'],
      schema,
      dataset,
    )) {
      documents.push(document);
    }

    expect(documents.map((document) => document.id).sort()).toEqual([
      'https://ex/d/1',
      'https://ex/d/2',
    ]);
    const byId = Object.fromEntries(
      documents.map((document) => [document.id, document]),
    );
    expect(byId['https://ex/d/1'].title_search_nl).toBe('titel');
  });

  it('frames a repeated root once (a non-DISTINCT selector may yield duplicates)', async () => {
    const quads = new Parser({ format: 'N-Triples' }).parse(
      `<https://ex/d/1> <${dsKey('title')}> "Titel"@nl .`,
    );

    const documents: SearchDocument[] = [];
    for await (const document of projectRoots(
      quads,
      ['https://ex/d/1', 'https://ex/d/1'],
      schema,
      dataset,
    )) {
      documents.push(document);
    }

    // One distinct root → one document, not one per occurrence.
    expect(documents.map((document) => document.id)).toEqual([
      'https://ex/d/1',
    ]);
  });

  it('yields a bare document, not paired with a searchType', async () => {
    const quads = new Parser({ format: 'N-Triples' }).parse(
      `<https://ex/d/1> <${dsKey('title')}> "Titel"@nl .`,
    );

    const documents: SearchDocument[] = [];
    for await (const document of projectRoots(
      quads,
      ['https://ex/d/1'],
      schema,
      dataset,
    )) {
      documents.push(document);
    }

    expect(documents).toHaveLength(1);
    expect(documents[0]).not.toHaveProperty('searchType');
    expect(documents[0]).not.toHaveProperty('document');
    expect(documents[0].id).toBe('https://ex/d/1');
  });

  it('frames only the given roots, ignoring other subjects in the quads', async () => {
    const quads = new Parser({ format: 'N-Triples' }).parse(`
      <https://ex/d/1> <${dsKey('title')}> "Een"@nl .
      <https://ex/d/2> <${dsKey('title')}> "Twee"@nl .
    `);

    const ids: string[] = [];
    for await (const document of projectRoots(
      quads,
      ['https://ex/d/1'],
      schema,
      dataset,
    )) {
      ids.push(document.id);
    }

    expect(ids).toEqual(['https://ex/d/1']);
  });

  it('keeps a blank-node referent of an inline reference', async () => {
    // JSON-LD 1.1 framing prunes a blank node identifier that occurs only once
    // in the results, so a blank-node referent arrives without an `@id`. A
    // nested document is not a document key – nesting needs the referent’s
    // fields – so it must survive framing with them intact.
    const mediaObject = defineSearchType({
      name: 'MediaObject',
      fields: [
        {
          name: 'encodingFormat',
          kind: 'keyword',
          array: true,
          output: true,
          path: 'https://schema.org/encodingFormat',
        },
      ],
    });
    const creativeWork = defineSearchType({
      name: 'CreativeWork',
      class: 'https://schema.org/CreativeWork',
      fields: [
        {
          name: 'media',
          kind: 'reference',
          array: true,
          output: true,
          path: 'https://schema.org/associatedMedia',
          ref: { typeName: 'MediaObject', strategy: 'inline' },
        },
      ],
    });
    const nestedSchema = searchSchema(creativeWork, mediaObject);
    const quads = new Parser({ format: 'N-Triples' }).parse(`
      <https://ex/w/1> <${alias('CreativeWork', 'media')}> _:b0 .
      _:b0 <${alias('MediaObject', 'encodingFormat')}> "image/jpeg" .
    `);

    const documents: SearchDocument[] = [];
    for await (const document of projectRoots(
      quads,
      ['https://ex/w/1'],
      nestedSchema,
      creativeWork,
    )) {
      documents.push(document);
    }

    expect(documents[0].media).toEqual([{ encodingFormat: ['image/jpeg'] }]);
  });

  it('keeps blank-node and named referents of one inline reference side by side', async () => {
    // The reproduction from the field: a work whose media are one blank node
    // (an image) and one named node (a IIIF manifest). Each referent keeps its
    // own values grouped; only the named one is keyed.
    const mediaObject = defineSearchType({
      name: 'MediaObject',
      fields: [
        {
          name: 'encodingFormat',
          kind: 'keyword',
          array: true,
          output: true,
          path: 'https://schema.org/encodingFormat',
        },
        {
          name: 'thumbnailUrl',
          kind: 'reference',
          output: true,
          path: 'https://schema.org/thumbnailUrl',
          ref: { typeName: 'MediaObject', strategy: 'idOnly' },
        },
      ],
    });
    const creativeWork = defineSearchType({
      name: 'CreativeWork',
      class: 'https://schema.org/CreativeWork',
      fields: [
        {
          name: 'media',
          kind: 'reference',
          array: true,
          output: true,
          path: 'https://schema.org/associatedMedia',
          ref: { typeName: 'MediaObject', strategy: 'inline' },
        },
      ],
    });
    const nestedSchema = searchSchema(creativeWork, mediaObject);
    const mediaAlias = alias('CreativeWork', 'media');
    const quads = new Parser({ format: 'N-Triples' }).parse(`
      <https://ex/w/1> <${mediaAlias}> _:b0 .
      _:b0 <${alias('MediaObject', 'encodingFormat')}> "image/jpeg" .
      _:b0 <${alias('MediaObject', 'thumbnailUrl')}> <https://ex/thumb.jpg> .
      <https://ex/w/1> <${mediaAlias}> <https://ex/iiif/manifest> .
      <https://ex/iiif/manifest> <${alias('MediaObject', 'encodingFormat')}> "application/ld+json" .
    `);

    const documents: SearchDocument[] = [];
    for await (const document of projectRoots(
      quads,
      ['https://ex/w/1'],
      nestedSchema,
      creativeWork,
    )) {
      documents.push(document);
    }

    expect(documents[0].media).toEqual(
      expect.arrayContaining([
        {
          encodingFormat: ['image/jpeg'],
          // Single-valued by declaration → the IRI itself.
          thumbnailUrl: 'https://ex/thumb.jpg',
        },
        {
          id: 'https://ex/iiif/manifest',
          encodingFormat: ['application/ld+json'],
        },
      ]),
    );
    expect(documents[0].media).toHaveLength(2);
  });

  it('rejects a searchType not in the schema (no forged schema)', async () => {
    const foreign: SearchType = {
      name: 'Other',
      class: 'http://example.org/Other',
      fields,
    };

    // The membership guard runs before the first yield, so advancing the
    // iterator once surfaces it.
    await expect(
      projectRoots([], ['https://ex/d/1'], schema, foreign)
        [Symbol.asyncIterator]()
        .next(),
    ).rejects.toThrow(/not in this engine’s schema/);
  });
});

describe('projection-time values', () => {
  const person = defineSearchType({
    name: 'Person',
    class: 'http://schema.org/Person',
    fields: [
      {
        name: 'dataset',
        kind: 'reference',
        from: 'dataset',
        output: true,
        filterable: true,
        facetable: true,
        ref: { strategy: 'lookup', target: 'Dataset' },
      },
    ],
  });

  it('populates a field declared over the indexed dataset', () => {
    const document = projectDocument(
      { '@id': 'https://ex/p/1' },
      person,
      undefined,
      { dataset: 'https://ex/d/1' },
    );

    expect(document.dataset).toBe('https://ex/d/1');
  });

  it('leaves the field absent when the caller supplies no dataset', () => {
    // Projecting a graph in isolation is legitimate; an absent value writes
    // nothing rather than a placeholder, exactly as an unmatched path does.
    const document = projectDocument({ '@id': 'https://ex/p/1' }, person);

    expect(document).not.toHaveProperty('dataset');
  });

  it('writes the folded search companion, like any other faceted field', () => {
    const searchable = defineSearchType({
      name: 'Person',
      class: 'http://schema.org/Person',
      fields: [
        {
          name: 'dataset',
          kind: 'keyword',
          from: 'dataset',
          facetable: true,
          searchable: { weight: 1 },
        },
      ],
    });

    const document = projectDocument(
      { '@id': 'https://ex/p/1' },
      searchable,
      undefined,
      { dataset: 'https://ex/D/1' },
    );

    expect(document.dataset).toBe('https://ex/D/1');
    expect(document.dataset_search).toBe('https://ex/d/1');
  });

  it('gives derive the context, so it can drop a value that is the containing dataset', () => {
    // `isPartOf` is polymorphic: it may point at a containing CreativeWork as
    // well as at the dataset. A deployment wanting only the former drops any
    // value equal to the dataset being indexed – which is only possible if the
    // dataset is known DURING projection.
    const work = defineSearchType({
      name: 'CreativeWork',
      class: 'http://schema.org/CreativeWork',
      fields: [
        {
          name: 'partOfRaw',
          kind: 'reference',
          path: 'http://schema.org/isPartOf',
          array: true,
        },
        {
          name: 'isPartOf',
          kind: 'reference',
          array: true,
          output: true,
          ref: { strategy: 'lookup', target: 'CreativeWork' },
          derive: (document, context) =>
            (document.partOfRaw as string[] | undefined)?.filter(
              (value) => value !== context.dataset,
            ),
        },
      ],
    });

    const document = projectDocument(
      {
        '@id': 'https://ex/w/1',
        [alias('CreativeWork', 'partOfRaw')]: [
          { '@id': 'https://ex/d/1' },
          { '@id': 'https://ex/w/parent' },
        ],
      },
      work,
      undefined,
      { dataset: 'https://ex/d/1' },
    );

    expect(document.isPartOf).toEqual(['https://ex/w/parent']);
  });

  it('reaches an inline referent’s own fields', () => {
    const media = defineSearchType({
      name: 'MediaObject',
      fields: [
        { name: 'dataset', kind: 'keyword', from: 'dataset', output: true },
      ],
    });
    const work = defineSearchType({
      name: 'CreativeWork',
      class: 'https://schema.org/CreativeWork',
      fields: [
        {
          name: 'media',
          kind: 'reference',
          path: 'https://schema.org/associatedMedia',
          output: true,
          ref: { typeName: 'MediaObject', strategy: 'inline' },
        },
      ],
    });
    const nested = searchSchema(work, media);

    const document = projectDocument(
      {
        '@id': 'https://ex/w/1',
        [alias('CreativeWork', 'media')]: { '@id': 'https://ex/m/1' },
      },
      work,
      nested,
      { dataset: 'https://ex/d/1' },
    );

    expect(document.media).toEqual({
      id: 'https://ex/m/1',
      dataset: 'https://ex/d/1',
    });
  });
});

describe('document keys (a type keyed on a declared field)', () => {
  const SCHEMA_ORG = 'https://schema.org/';
  const GEONAMES = 'https://sws.geonames.org/';
  const WIKIDATA = 'https://www.wikidata.org/entity/';

  /** A deployment’s IRI normalisation: one spelling per alignment target, so two
   *  publishers writing the same place alike key it alike. */
  const normaliseIri = (iri: string) =>
    iri.replace(/^http:/, 'https:').replace(/\/$/, '');

  const place = defineSearchType({
    name: 'Place',
    class: `${SCHEMA_ORG}Place`,
    labelField: 'name',
    // A preference order, not a filter: GeoNames first, then any other covered
    // source; nothing matched keeps the publisher’s own node.
    key: {
      field: '_sameAs',
      pick: (candidates) =>
        candidates.find((iri) => iri.startsWith(GEONAMES)) ??
        candidates.find((iri) => iri.startsWith(WIKIDATA)),
    },
    fields: [
      {
        name: 'name',
        kind: 'text',
        path: `<${SCHEMA_ORG}name>`,
        locales: ['und'],
        output: true,
        searchable: { weight: 1 },
      },
      {
        // Internal: extracted and read for the key, then pruned before the writer.
        name: '_sameAs',
        kind: 'reference',
        array: true,
        path: `<${SCHEMA_ORG}sameAs>`,
        transform: normaliseIri,
      },
    ],
  });

  const work = defineSearchType({
    name: 'CreativeWork',
    class: `${SCHEMA_ORG}CreativeWork`,
    fields: [
      {
        name: 'locationCreated',
        kind: 'reference',
        path: `<${SCHEMA_ORG}locationCreated>`,
        facetable: true,
        output: true,
        ref: { strategy: 'lookup', target: 'Place' },
      },
      {
        name: 'about',
        kind: 'reference',
        array: true,
        path: `<${SCHEMA_ORG}about>`,
        facetable: true,
        labelSource: 'Place',
      },
      {
        // Names no target, so it never claimed to hold a collection’s ids.
        name: 'unnamed',
        kind: 'reference',
        array: true,
        path: `<${SCHEMA_ORG}mentions>`,
        facetable: true,
      },
    ],
  });

  const keyedSchema = searchSchema(place, work);
  const placeKey = (field: string) => alias('Place', field);
  const workKey = (field: string) => alias('CreativeWork', field);

  /** A framed place node, with the raw values the CONSTRUCT emitted for it. */
  const placeNode = (id: string, ...sameAs: string[]) => ({
    '@id': id,
    [placeKey('name')]: [{ '@value': 'Kessel' }],
    ...(sameAs.length === 0
      ? {}
      : { [placeKey('_sameAs')]: sameAs.map((iri) => ({ '@id': iri })) }),
  });

  it('keys a root on the field’s value, not on the node IRI', () => {
    const document = projectDocument(
      placeNode('https://ex/place/1', `${GEONAMES}2751283`),
      place,
      keyedSchema,
    );

    expect(document.id).toBe(`${GEONAMES}2751283`);
    // The key field itself is internal, so it never reaches the writer.
    expect(document).not.toHaveProperty('_sameAs');
  });

  it('keeps the node’s own IRI when the key field is empty', () => {
    expect(
      projectDocument(placeNode('https://ex/place/1'), place, keyedSchema).id,
    ).toBe('https://ex/place/1');
  });

  it('keeps the node’s own IRI when pick declines every candidate', () => {
    // A candidate in no source `pick` prefers: the publisher keeps its node.
    expect(
      projectDocument(
        placeNode('https://ex/place/1', 'https://ex/other/1'),
        place,
        keyedSchema,
      ).id,
    ).toBe('https://ex/place/1');
  });

  it('applies the key field’s transform before pick, so spellings merge', () => {
    // Two publishers spelling one GeoNames IRI differently – `http://` and a
    // trailing slash – project to ONE document key, which is what makes the
    // writer’s upsert merge them.
    const first = projectDocument(
      placeNode('https://a/place/1', 'http://sws.geonames.org/2751283/'),
      place,
      keyedSchema,
    );
    const second = projectDocument(
      placeNode('https://b/place/9', `${GEONAMES}2751283`),
      place,
      keyedSchema,
    );

    expect(first.id).toBe(`${GEONAMES}2751283`);
    expect(second.id).toBe(first.id);
  });

  it('sorts and dedupes the candidates, whatever order the CONSTRUCT returned', () => {
    // `pick` here takes the FIRST candidate (the default), so the answer is
    // stable only because the candidates are sorted before it sees them.
    const unordered = defineSearchType({
      ...place,
      name: 'AnyPlace',
      class: 'urn:x:AnyPlace',
      key: { field: '_sameAs' },
    });
    const anySchema = searchSchema(unordered);
    const candidates = [`${WIKIDATA}Q1`, `${GEONAMES}1`, `${WIKIDATA}Q1`];
    const forward = {
      '@id': 'https://ex/place/1',
      [alias('AnyPlace', '_sameAs')]: candidates.map((iri) => ({ '@id': iri })),
    };
    const reversed = {
      '@id': 'https://ex/place/1',
      [alias('AnyPlace', '_sameAs')]: [...candidates]
        .reverse()
        .map((iri) => ({ '@id': iri })),
    };

    expect(projectDocument(forward, unordered, anySchema).id).toBe(
      `${GEONAMES}1`,
    );
    expect(projectDocument(reversed, unordered, anySchema).id).toBe(
      `${GEONAMES}1`,
    );
  });

  it('throws when pick returns a value that is not a candidate', () => {
    // A key must be an IRI the graph offered for that node – the same pure
    // function keys the document AND every reference to it, so a `pick` that
    // invents one would key the two differently.
    const invented = defineSearchType({
      ...place,
      name: 'Invented',
      class: 'urn:x:Invented',
      key: { field: '_sameAs', pick: () => 'https://elsewhere/1' },
    });

    expect(() =>
      projectDocument(
        {
          '@id': 'https://ex/place/1',
          [alias('Invented', '_sameAs')]: [{ '@id': `${GEONAMES}1` }],
        },
        invented,
        searchSchema(invented),
      ),
    ).toThrow(
      /returned “https:\/\/elsewhere\/1” for <https:\/\/ex\/place\/1>, which is not among its candidates \(<https:\/\/sws\.geonames\.org\/1>\)/,
    );
  });

  it('stores a referent’s key on a lookup and on a labelSource reference', () => {
    // Both name their target, which is what a `lookup`/`labelSource` already
    // means: this field holds ids of documents in that collection.
    const document = projectDocument(
      {
        '@id': 'https://ex/work/1',
        [workKey('locationCreated')]: {
          '@id': 'https://ex/place/1',
          [placeKey('_sameAs')]: [{ '@id': `${GEONAMES}2751283` }],
        },
        [workKey('about')]: [
          {
            '@id': 'https://ex/place/2',
            [placeKey('_sameAs')]: [{ '@id': `${WIKIDATA}Q1` }],
          },
        ],
      },
      work,
      keyedSchema,
    );

    expect(document.locationCreated).toBe(`${GEONAMES}2751283`);
    expect(document.about).toEqual([`${WIKIDATA}Q1`]);
  });

  it('stores the referent’s own IRI when it offers no key', () => {
    // An unaligned place: the reference still resolves, against the document
    // that place is written under.
    const document = projectDocument(
      {
        '@id': 'https://ex/work/1',
        [workKey('locationCreated')]: { '@id': 'https://ex/place/1' },
        // A reference naming no target is never re-keyed, even into a keyed type.
        [workKey('unnamed')]: [
          {
            '@id': 'https://ex/place/2',
            [placeKey('_sameAs')]: [{ '@id': `${GEONAMES}1` }],
          },
        ],
      },
      work,
      keyedSchema,
    );

    expect(document.locationCreated).toBe('https://ex/place/1');
    expect(document.unnamed).toEqual(['https://ex/place/2']);
  });

  it('re-keys a referent given as a bare IRI, and drops a value that is none', () => {
    // `schema:sameAs` and friends range on `schema:URL`, which a source may emit
    // as a literal – so a reference value may arrive as a bare string, carrying
    // no candidates of its own; a value that is no IRI at all yields nothing,
    // exactly as it does for an unkeyed reference.
    const document = projectDocument(
      {
        '@id': 'https://ex/work/1',
        [workKey('about')]: ['https://ex/place/3', { '@value': 'Kessel' }],
      },
      work,
      keyedSchema,
    );

    expect(document.about).toEqual(['https://ex/place/3']);
  });

  it('runs the referring field’s transform on the key, not the node IRI', () => {
    // A `transform` transforms what the field STORES, and for a keyed target
    // that is the key – so a transform written against the referent’s node IRIs
    // sees a key instead. Pinned because the two are only worth declaring
    // together deliberately.
    const seen: string[] = [];
    const withTransform = defineSearchType({
      ...work,
      name: 'TransformingWork',
      class: 'urn:x:TransformingWork',
      fields: [
        {
          name: 'about',
          kind: 'reference',
          array: true,
          path: `<${SCHEMA_ORG}about>`,
          facetable: true,
          labelSource: 'Place',
          transform: (value) => {
            seen.push(value);
            return value;
          },
        },
      ],
    });
    projectDocument(
      {
        '@id': 'https://ex/work/1',
        [alias('TransformingWork', 'about')]: [
          {
            '@id': 'https://ex/place/1',
            [placeKey('_sameAs')]: [{ '@id': `${GEONAMES}1` }],
          },
        ],
      },
      withTransform,
      searchSchema(place, withTransform),
    );

    expect(seen).toEqual([`${GEONAMES}1`]);
  });

  it('leaves a reference into an unkeyed target alone', () => {
    const unkeyed = defineSearchType({
      name: 'Place',
      class: `${SCHEMA_ORG}Place`,
      labelField: 'name',
      fields: place.fields,
    });
    const document = projectDocument(
      {
        '@id': 'https://ex/work/1',
        [workKey('locationCreated')]: {
          '@id': 'https://ex/place/1',
          [placeKey('_sameAs')]: [{ '@id': `${GEONAMES}1` }],
        },
      },
      work,
      searchSchema(unkeyed, work),
    );

    expect(document.locationCreated).toBe('https://ex/place/1');
  });

  it('leaves references as they are when projected without a schema', () => {
    // No schema, no way to resolve the target – the same graceful degradation
    // an inline reference makes.
    const document = projectDocument(
      {
        '@id': 'https://ex/work/1',
        [workKey('locationCreated')]: {
          '@id': 'https://ex/place/1',
          [placeKey('_sameAs')]: [{ '@id': `${GEONAMES}1` }],
        },
      },
      work,
    );

    expect(document.locationCreated).toBe('https://ex/place/1');
  });

  it('assigns the key before any derive runs', () => {
    const withDerive = defineSearchType({
      ...place,
      name: 'DerivedPlace',
      class: 'urn:x:DerivedPlace',
      key: { field: '_sameAs' },
      fields: [
        ...place.fields,
        {
          name: 'keyedOn',
          kind: 'keyword',
          output: true,
          derive: (document) => document.id,
        },
      ],
    });

    expect(
      projectDocument(
        {
          '@id': 'https://ex/place/1',
          [alias('DerivedPlace', '_sameAs')]: [{ '@id': `${GEONAMES}1` }],
        },
        withDerive,
        searchSchema(withDerive),
      ).keyedOn,
    ).toBe(`${GEONAMES}1`);
  });

  it('lets two distinct roots project to one document key', async () => {
    // Two publishers’ nodes for one place. The projection emits both documents,
    // under one `id`; folding them is the writer’s upsert, not the projection’s.
    const quads = new Parser({ format: 'N-Triples' }).parse(`
      <https://a/place/1> <${placeKey('_sameAs')}> <${GEONAMES}2751283> .
      <https://b/place/9> <${placeKey('_sameAs')}> <${GEONAMES}2751283> .
    `);

    const documents: SearchDocument[] = [];
    for await (const document of projectRoots(
      quads,
      ['https://a/place/1', 'https://b/place/9'],
      keyedSchema,
      place,
    )) {
      documents.push(document);
    }

    expect(documents.map((document) => document.id)).toEqual([
      `${GEONAMES}2751283`,
      `${GEONAMES}2751283`,
    ]);
  });
});
