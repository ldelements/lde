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

const node = {
  '@id': 'https://ex/d/1',
  [dcterms.title.value]: [
    { '@language': 'nl', '@value': 'Titel' },
    { '@language': 'en', '@value': 'Title' },
  ],
  [dcterms.publisher.value]: { '@id': 'https://ex/o/1' },
  [`${DR}publisherName`]: { '@language': 'nl', '@value': 'Erfgoed' },
  [dcat.keyword.value]: [{ '@language': 'nl', '@value': 'Erfgoed' }],
  [`${DR}format`]: [`${IANA}text/turtle`],
  [`${DR}class`]: [{ '@id': 'http://schema.org/Person' }],
  [`${DR}datePosted`]: { '@value': '2024-01-01T00:00:00.000Z' },
  [`${DR}size`]: { '@type': xsd.integer.value, '@value': '1234' },
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
    searchable: { weight: 1 },
  },
  {
    name: 'format',
    path: `${DR}format`,
    kind: 'keyword',
    facetable: true,
    transform: (value) => value.replace(IANA, ''),
  },
  { name: 'class', path: `${DR}class`, kind: 'reference', facetable: true },
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
    expect(document.publisher).toEqual(['https://ex/o/1']);
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
        [`${DR}size`]: { '@value': 42 },
        [dcterms.language.value]: { '@value': true },
        [dcat.keyword.value]: 'bareString',
        [`${DR}class`]: 'http://example.org/BareClass',
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
    expect(document.language).toEqual(['true']);
    expect(document.keyword).toEqual(['bareString']);
    expect(document.class).toEqual(['http://example.org/BareClass']);
  });

  it('projects a number field as a float (not truncated like integer)', () => {
    const document = projectDocument(
      { '@id': 'https://ex/d/12', [`${DR}size`]: { '@value': '1234.5' } },
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
        { '@id': 'https://ex/d/5', [`${DR}iiif`]: { '@value': value } },
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

  it('folds the transformed values (not the raw ones) for a facet search field', () => {
    const document = projectDocument(
      { '@id': 'https://ex/d/4', [`${DR}format`]: [`${IANA}text/turtle`] },
      {
        name: 'Dataset',
        class: DATASET,
        fields: [
          {
            name: 'format',
            path: `${DR}format`,
            kind: 'keyword',
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
        [dcterms.title.value]: { '@language': 'nl', '@value': 'Solo' },
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
        [dcterms.title.value]: { '@language': 'fr', '@value': 'Bonjour' },
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
        [dcterms.title.value]: { '@language': 'pt_BR', '@value': 'Mapa' },
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
        [dcterms.title.value]: { '@value': 'Naamloos' },
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
        [dcterms.title.value]: { '@language': 'nl', '@value': 'Verhalen' },
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
        [dcterms.title.value]: [
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
        [dcterms.title.value]: [
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
        [dcterms.title.value]: { '@language': 'nl', '@value': 'Titel' },
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

  it('prunes an internal (zero-role) field of every non-text kind from the document', () => {
    const document = projectDocument(
      {
        '@id': 'https://ex/d/internal',
        [`${DR}token`]: ['tok'],
        [`${DR}ref`]: { '@id': 'https://ex/o/9' },
        [`${DR}count`]: { '@value': '7' },
        [`${DR}score`]: { '@value': '1.5' },
        [`${DR}flag`]: { '@value': 'true' },
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
        [`${DR}class`]: [
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
          { name: 'classes', path: `${DR}class`, kind: 'reference' },
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
        [`${DR}registration`]: [
          {
            '@id': 'https://ex/r/1',
            'https://schema.org/dateRead': { '@value': '2024-01-01T00:00:00Z' },
            'https://schema.org/datePosted': {
              '@value': '2024-02-01T00:00:00Z',
            },
          },
          {
            '@id': 'https://ex/r/2',
            'https://schema.org/dateRead': { '@value': '2024-06-01T00:00:00Z' },
            'https://schema.org/datePosted': {
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
        [`${DR}registration`]: { '@id': 'https://ex/r/1' },
      },
      dataset,
    );
    expect(document).toEqual({ id: 'https://ex/d/noschema' });
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
        [`${DR}registration`]: { '@id': 'https://ex/r/9' },
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
          searchable: { weight: 1 },
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
        [`${DR}creator`]: {
          '@id': 'https://ex/c/1',
          'https://schema.org/name': { '@language': 'nl', '@value': 'Naam' },
        },
      },
      dataset,
      withReference,
    );

    // An output inline reference surfaces its referent as a nested Search
    // Document (its Reference Type’s projected fields), not a bare IRI.
    expect(document.creator).toMatchObject({
      id: 'https://ex/c/1',
      label_nl: 'Naam',
      label_search_nl: 'naam',
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
          searchable: { weight: 1 },
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
          derive: (referent) =>
            (referent.rawSort as readonly string[] | undefined)?.[0],
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
        [`${DR}creator`]: [
          {
            '@id': 'https://ex/c/2',
            'https://schema.org/name': { '@language': 'nl', '@value': 'Naam' },
            'https://schema.org/alternateName': 'Alt',
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

  it('buckets untagged literals into the reserved und locale', () => {
    const document = projectDocument(
      {
        '@id': 'https://ex/d/13',
        [dcterms.title.value]: [
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
        [dcterms.title.value]: [
          { '@language': 'nl', '@value': 'Titel' },
          { '@language': 'nl', '@value': { nested: true } },
        ],
        [dcat.keyword.value]: [{ '@value': { nested: true } }, 'kaart'],
        [dcterms.publisher.value]: [{ nested: true }, { '@id': 'https://o/1' }],
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
    expect(document.keyword).toEqual(['kaart']);
    expect(document.publisher).toEqual(['https://o/1']);
  });

  it('throws when the framed node has no @id', () => {
    expect(() =>
      projectDocument(
        { [dcterms.title.value]: { '@value': 'No id' } },
        { name: 'Dataset', class: DATASET, fields },
      ),
    ).toThrow(/without an @id/);
  });

  it('projects nothing for a localized field with no locales (rejected at declaration time)', () => {
    // validateSearchType owns the empty-locales rule; the projection itself
    // stays total for hand-built maps that bypassed searchSchema().
    const document = projectDocument(
      {
        '@id': 'https://ex/d/9',
        [dcterms.title.value]: { '@language': 'nl', '@value': 'Titel' },
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
      <https://ex/d/1> <${dcterms.title.value}> "Titel"@nl .
      <https://ex/d/2> <${dcterms.title.value}> "Andere"@nl .
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
      `<https://ex/d/1> <${dcterms.title.value}> "Titel"@nl .`,
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
      `<https://ex/d/1> <${dcterms.title.value}> "Titel"@nl .`,
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
      <https://ex/d/1> <${dcterms.title.value}> "Een"@nl .
      <https://ex/d/2> <${dcterms.title.value}> "Twee"@nl .
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
