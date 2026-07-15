import type { CollectionCreateSchema } from 'typesense';
import type { CollectionFieldSchema } from 'typesense/lib/Typesense/Collection.js';
import { type SearchField, type SearchType } from '@lde/search';
import { displayFieldPattern, physicalFields } from '@lde/search/adapter';

/** Deployment-specific options the generic field model does not carry. */
export interface CollectionDefinitionOptions {
  /** The Typesense collection (or alias) name. */
  readonly name: string;
  /** Snowball stemming locale for non-localized searchable fields (e.g. `en`).
   *  Unset, those fields are not stemmed – folding still applies – so no
   *  language is ever assumed. Localized text search fields always stem in
   *  their own locale. */
  readonly defaultLocale?: string;
  /** The field Typesense sorts by when a query imposes no order. */
  readonly defaultSortingField?: string;
  /** Synonym sets the collection references (synced separately). */
  readonly synonymSets?: readonly string[];
}

/**
 * Build a Typesense collection definition from the unified {@link SearchType}, so
 * the index and the projection are driven by one declarative source and cannot
 * drift. Each field fans out into the same physical fields the projection writes
 * ({@link physicalFields}); the Typesense field type is derived from the field
 * `kind`, never re-declared.
 *
 * Text stems each folded `*_search_${locale}` field in its own language; the
 * untagged `und` locale (and any searchable keyword/reference companion)
 * stems in `defaultLocale` when one is set, and is left unstemmed (folded
 * only) otherwise.
 *
 * Memory lever: Typesense holds the index in RAM (with a raw copy of each
 * document on disk), so RAM tracks the *indexed* surface – roughly 2–3× the
 * size of the fields you search, facet or sort on – not the whole document.
 * This builder keeps that surface minimal: the `output` display labels land in
 * a single `index: false` regex field (`${name}_<lang>`, one value per present
 * language), kept on disk and read back only for a hit, so they cost no RAM;
 * only the folded `*_search_${locale}`, facet/reference and `*_sort_${locale}`
 * companions are indexed. Keeping retrieval-only fields un-indexed is the lever
 * for holding a large index’s RAM down.
 */
export function buildCollectionDefinition(
  searchType: SearchType,
  options: CollectionDefinitionOptions,
): CollectionCreateSchema {
  const { defaultLocale } = options;
  const collection: CollectionCreateSchema = {
    name: options.name,
    fields: searchType.fields.flatMap((field) =>
      typesenseFields(field, defaultLocale, options.defaultSortingField),
    ),
  };
  if (options.defaultSortingField !== undefined) {
    collection.default_sorting_field = options.defaultSortingField;
  }
  if (options.synonymSets !== undefined) {
    collection.synonym_sets = [...options.synonymSets];
  }
  return collection;
}

/** The physical Typesense fields one declaration produces. */
function typesenseFields(
  field: SearchField,
  defaultLocale: string | undefined,
  defaultSortingField: string | undefined,
): CollectionFieldSchema[] {
  const names = physicalFields(field);
  if (field.kind === 'text') {
    const locales = field.locales;
    const displayPattern = displayFieldPattern(field);
    return [
      // Display labels: ONE regex field (`${name}_<lang>`) storing every
      // present language’s value, NOT indexed (`index: false`) – search hits
      // the folded `*_search` companions, so the display copies stay on disk and
      // off RAM (fetched only for a hit), accents preserved, and a language
      // outside `locales` still renders. This is the memory lever: RAM tracks
      // the search surface, not the display text. Absent for a non-output field.
      ...(displayPattern !== undefined
        ? [
            {
              name: displayPattern,
              type: 'string',
              index: false,
              optional: true,
            } satisfies CollectionFieldSchema,
          ]
        : []),
      // One folded search field per locale, each stemmed in its own
      // language; the untagged `und` locale is folded but unstemmed unless
      // the deployment opts in via `defaultLocale`.
      ...names.search.map((name, index): CollectionFieldSchema => {
        const locale =
          locales[index] === 'und' ? defaultLocale : locales[index];
        return {
          name,
          type: 'string',
          optional: true,
          ...(locale !== undefined && { stem: true, locale }),
        };
      }),
      ...names.sort.map(
        (name): CollectionFieldSchema => ({
          name,
          type: 'string',
          sort: true,
          optional: true,
        }),
      ),
    ];
  }

  const valueType = typesenseValueType(field);
  const fields: CollectionFieldSchema[] = [
    {
      name: field.name,
      type: valueType,
      facet: field.facetable ?? false,
      sort: field.sortable ?? false,
      // A `required` field is non-optional; so is the `default_sorting_field`,
      // which Typesense requires to be present. Everything else may be absent.
      optional: field.required !== true && field.name !== defaultSortingField,
    },
  ];
  // `names.search` is non-empty exactly when the field projects a folded
  // search companion – physicalFields owns that rule.
  for (const name of names.search) {
    fields.push({
      name,
      type: valueType,
      optional: true,
      ...(defaultLocale !== undefined && {
        stem: true,
        locale: defaultLocale,
      }),
    });
  }
  return fields;
}

/** The Typesense field type for a non-localized field, from its `kind`. 64-bit
 *  integers (and dates, stored as Unix seconds) so large counts never overflow. */
function typesenseValueType(field: SearchField): CollectionFieldSchema['type'] {
  switch (field.kind) {
    case 'integer':
    case 'date':
      return 'int64';
    case 'number':
      return 'float';
    case 'boolean':
      return 'bool';
    case 'keyword':
    case 'reference':
    case 'text':
      return field.array === true ? 'string[]' : 'string';
  }
}
