import type { CollectionCreateSchema } from 'typesense';
import type { CollectionFieldSchema } from 'typesense/lib/Typesense/Collection.js';
import {
  type ReferenceType,
  type SearchField,
  type SearchSchema,
  type SearchType,
} from '@lde/search';
import {
  displayFieldPattern,
  isInlineReference,
  isInternalField,
  nestedFieldName,
  nestedReferenceType,
  physicalFields,
} from '@lde/search/adapter';
import { deriveCollectionName } from './collection-name.js';

/** Deployment-specific options the generic field model does not carry. */
export interface CollectionDefinitionOptions {
  /** The Typesense collection (or alias) name. Omit to derive it from the
   *  type’s `name` ({@link deriveCollectionName}); supply one to override that
   *  (an env prefix, a multi-tenant name, an existing collection). */
  readonly name?: string;
  /**
   * The Search Schema the type belongs to – required only when the type
   * surfaces an inline reference, whose nested fields are declared from the
   * {@link ReferenceType} the schema resolves. A type without one needs no
   * schema, so a caller that declares no nesting passes none; a type that does
   * fails here rather than building a collection that silently omits the
   * nesting.
   */
  readonly schema?: SearchSchema;
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
 * The collection `name` is optional: omitted, it is derived from the type’s own
 * `name` ({@link deriveCollectionName}), so a caller that has no naming opinion
 * states none.
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
 *
 * {@link isInternalField Internal fields} (those declaring no role) are omitted
 * entirely: they exist only as a projection-time reading device for the
 * derives, so the collection stores nothing for them.
 *
 * A surfaced (`output`) inline reference is stored as a **nested object** –
 * `object` or `object[]` – with one nested Physical Field per output field of
 * its {@link ReferenceType} ({@link nestedFieldName}), which turns on
 * `enable_nested_fields` for the collection. Nested fields carry `output` only
 * (enforced by `searchSchema`), so they are declared `index: false`: each
 * referent’s values stay grouped on disk and cost no RAM, exactly like the
 * display labels.
 */
export function buildCollectionDefinition(
  searchType: SearchType,
  options: CollectionDefinitionOptions = {},
): CollectionCreateSchema {
  const { defaultLocale } = options;
  const collection: CollectionCreateSchema = {
    name: options.name ?? deriveCollectionName(searchType),
    fields: searchType.fields.flatMap((field) =>
      typesenseFields(
        searchType,
        field,
        defaultLocale,
        options.defaultSortingField,
        options.schema,
      ),
    ),
  };
  // Typesense rejects an `object`/`object[]` field unless nesting is enabled,
  // so the flag is a consequence of the declaration – never a knob.
  if (collection.fields?.some((field) => field.type.startsWith('object'))) {
    collection.enable_nested_fields = true;
  }
  if (options.defaultSortingField !== undefined) {
    collection.default_sorting_field = options.defaultSortingField;
  }
  if (options.synonymSets !== undefined) {
    collection.synonym_sets = [...options.synonymSets];
  }
  return collection;
}

/**
 * The {@link ReferenceType} a field nests, or `undefined` when it nests
 * nothing. Throws when the type surfaces an inline reference the caller gave no
 * schema to resolve: the collection would silently store the reference as a
 * string the projection never writes, so every document would fail to import.
 */
function nestedTypeOf(
  searchType: SearchType,
  field: SearchField,
  schema: SearchSchema | undefined,
): ReferenceType | undefined {
  const nested =
    schema === undefined ? undefined : nestedReferenceType(schema, field);
  // Reached only for a field carrying a Role, so an inline reference here is a
  // surfaced one: `searchSchema` allows an inline reference no Role but
  // `output`.
  if (nested === undefined && isInlineReference(field)) {
    throw new Error(
      `Building the collection for “${searchType.name}” needs the search schema its surfaced inline reference “${field.name}” resolves against; pass it as the collection-definition option “schema”.`,
    );
  }
  return nested;
}

/** The physical Typesense fields one declaration produces. */
function typesenseFields(
  searchType: SearchType,
  field: SearchField,
  defaultLocale: string | undefined,
  defaultSortingField: string | undefined,
  schema: SearchSchema | undefined,
): CollectionFieldSchema[] {
  // An internal field (no role) is projected as a reading device for the
  // derives and pruned before the writer, so the collection stores nothing for
  // it: not stored, not indexed, no RAM. Same predicate the projection prunes
  // by, so the index and the document cannot disagree.
  if (isInternalField(field)) {
    return [];
  }
  const nested = nestedTypeOf(searchType, field, schema);
  if (nested !== undefined) {
    return nestedFields(field.name, field, nested, schema as SearchSchema);
  }
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
      ...names.sort.map((name): CollectionFieldSchema => ({
        name,
        type: 'string',
        sort: true,
        optional: true,
      })),
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

/**
 * The nested object one surfaced inline reference stores, plus one nested
 * Physical Field per output field of its {@link ReferenceType} – recursing for
 * a reference type that itself surfaces an inline reference, to the depth the
 * schema declares (`searchSchema` rejects inline cycles, so the recursion
 * terminates).
 *
 * Everything nested is `index: false`: a nested field carries `output` only, so
 * it is stored with its referent and read back with it, never searched, faceted
 * or sorted on. That keeps the RAM lever intact – a nested document is display
 * weight, like the per-language labels – and lets the declared child types be
 * exactly what the projection writes without an indexing contract to satisfy.
 * Declaring the children rather than only the object is what makes the nesting
 * legible in the collection, and what keeps an {@link isInternalField Internal
 * Field} inside a Reference Type visibly contributing nothing.
 */
function nestedFields(
  prefix: string,
  reference: SearchField,
  referenceType: ReferenceType,
  schema: SearchSchema,
): CollectionFieldSchema[] {
  const array = reference.array === true;
  const fields: CollectionFieldSchema[] = [
    {
      name: prefix,
      type: array ? 'object[]' : 'object',
      index: false,
      optional: reference.required !== true,
    },
  ];
  for (const field of referenceType.fields) {
    if (isInternalField(field)) {
      continue;
    }
    const nested = nestedReferenceType(schema, field);
    if (nested !== undefined) {
      fields.push(
        ...nestedFields(
          nestedFieldName(prefix, field.name),
          field,
          nested,
          schema,
        ),
      );
      continue;
    }
    // A nested text field stores its display values exactly as a root one does
    // – one `${name}_<lang>` per present language, matched by one pattern
    // field – only under the referent’s prefix. It has no search or sort
    // companions: those are Roles a nested field cannot declare.
    const pattern =
      field.kind === 'text' ? displayFieldPattern(field) : undefined;
    fields.push({
      name: nestedFieldName(prefix, pattern ?? field.name),
      type: field.kind === 'text' ? 'string' : typesenseValueType(field),
      index: false,
      // Always optional: `required` is a promise about the *referent* (this
      // value is on every referent), while Typesense’s flag is about the
      // document. Under a multi-valued reference those are different claims,
      // and only the referent-level one is the declaration’s.
      optional: true,
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
