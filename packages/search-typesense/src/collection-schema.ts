import type { CollectionCreateSchema } from 'typesense';
import type { CollectionFieldSchema } from 'typesense/lib/Typesense/Collection.js';
import { physicalFields, type SearchField, type SearchType } from '@lde/search';

/** Deployment-specific options the generic field model does not carry. */
export interface CollectionSchemaOptions {
  /** The Typesense collection (or alias) name. */
  readonly name: string;
  /** Snowball stemming locale for non-localized searchable fields (e.g. `en`).
   *  Unset, those fields are not stemmed — folding still applies — so no
   *  language is ever assumed. Localized text search fields always stem in
   *  their own locale. */
  readonly defaultLocale?: string;
  /** The field Typesense sorts by when a query imposes no order. */
  readonly defaultSortingField?: string;
  /** Synonym sets the collection references (synced separately). */
  readonly synonymSets?: readonly string[];
}

/**
 * Build a Typesense collection schema from the unified {@link SearchType}, so
 * the index and the projection are driven by one declarative source and cannot
 * drift. Each field fans out into the same physical fields the projection writes
 * ({@link physicalFields}); the Typesense field type is derived from the field
 * `kind`, never re-declared.
 *
 * Localized text stems each folded `*_search_${locale}` field in its own
 * language; a non-localized searchable field stems in `defaultLocale` when one
 * is set, and is left unstemmed (folded only) otherwise.
 */
export function buildCollectionSchema(
  searchType: SearchType,
  options: CollectionSchemaOptions,
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
  if (field.kind === 'text' && field.localized === true) {
    const locales = field.locales ?? [];
    return [
      // Display labels: stored, not indexed for search (search uses the folded
      // companions), accents preserved.
      ...names.display.map(
        (name): CollectionFieldSchema => ({
          name,
          type: 'string',
          index: false,
          optional: true,
        }),
      ),
      // One folded search field per locale, each stemmed in its own language.
      ...names.search.map(
        (name, index): CollectionFieldSchema => ({
          name,
          type: 'string',
          optional: true,
          stem: true,
          locale: locales[index],
        }),
      ),
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
  if (field.searchable) {
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
