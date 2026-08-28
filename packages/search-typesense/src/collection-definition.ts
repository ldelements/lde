import type { CollectionCreateSchema } from 'typesense';
import type { CollectionFieldSchema } from 'typesense/lib/Typesense/Collection.js';
import {
  type SearchField,
  type SearchSchema,
  type SearchType,
} from '@lde/search';
import {
  displayFieldPattern,
  ID_FIELD,
  isInlineReference,
  isInternalField,
  joinGraph,
  localLookupTypeOf,
  nestedFieldName,
  nestedReferenceType,
  physicalFields,
} from '@lde/search/adapter';
import { deriveCollectionName } from './collection-name.js';

/** Deployment-specific options the generic field model does not carry. */
export interface CollectionDefinitionOptions {
  /**
   * How a search type is named in Typesense – for **this** type and, where it
   * declares a {@link ReferenceField.joinable} reference, for the peer type
   * that reference points at. Omit to derive every name from the type’s own
   * `name` ({@link deriveCollectionName}); supply one to override that (an env
   * prefix, a multi-tenant name, an existing collection).
   *
   * A function of the type rather than a bare name, because an emitted
   * reference field must name the peer’s **concrete** collection: a
   * blue/green writer therefore hands in a function that appends the run’s
   * version to every name in the component, so a fresh build references its
   * peer’s fresh collection rather than the live one. No coordinator is
   * needed – every writer in a run receives the same `RunContext`, so they
   * derive identical names.
   */
  readonly collectionNameFor?: (searchType: SearchType) => string;
  /**
   * The Search Schema the type belongs to – required when the type carries an
   * inline reference (whose nested fields are declared from the reference type
   * the schema resolves), or declares a joinable reference (whose target
   * collection the schema’s {@link joinGraph} resolves).
   * A type doing neither needs no schema, so a caller passes none;
   * a type that does fails here rather than building a collection that
   * silently omits the nesting or the reference.
   *
   * Also what resolves the facet policy a facetable reference inherits from
   * the type it names ({@link physicalFields}): without the schema the field
   * itself is declared the facet and no `${name}_facet` companion is, the same
   * reading the projection makes without one. Whether a policy applies cannot
   * be told without the schema, so this is not guarded: a deployment that
   * declares one and builds its collections schema-less meets the engine’s own
   * error on the first facet query, not a silently narrowed-to-nothing facet.
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
 * Collection naming is optional: omitted, every name – this type’s and the peer
 * types its joins point at – is derived from the type’s own `name`
 * ({@link deriveCollectionName}), so a caller that has no naming opinion states
 * none.
 *
 * A {@link ReferenceField.joinable} reference is emitted as a Typesense
 * **reference field** pointing at its target collection’s `id`, so a query can
 * filter this type by a condition on the referent
 * ({@link referenceDeclaration}).
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
 * An inline reference is stored as a **nested object** – `object` or
 * `object[]` – with one nested Physical Field per field of the type it nests
 * ({@link nestedFieldName}), which turns on `enable_nested_fields` for the
 * collection. A nested field is `index: false` unless it declares a query Role,
 * so a display-only nesting stays disk weight and costs no RAM, exactly like
 * the display labels; one that opts into `filterable` or `searchable` is
 * indexed, and its parent object with it (see {@link nestedFields}).
 *
 * An inline reference declaring `filterable` or `facetable` also emits its
 * {@link ReferenceStrategy.identity identity companion} – a flat id field the
 * engine can filter and facet, which a nested object is not
 * ({@link identityCompanionFields}).
 */
export function buildCollectionDefinition(
  searchType: SearchType,
  options: CollectionDefinitionOptions = {},
): CollectionCreateSchema {
  const { defaultLocale, collectionNameFor = deriveCollectionName } = options;
  const collection: CollectionCreateSchema = {
    name: collectionNameFor(searchType),
    fields: searchType.fields.flatMap((field) =>
      typesenseFields(
        searchType,
        field,
        defaultLocale,
        options.defaultSortingField,
        options.schema,
        collectionNameFor,
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
 * The type a field nests, or `undefined` when it nests nothing. Throws when the
 * type carries an inline reference the caller gave no schema to resolve: the
 * collection would silently store the reference as a string the projection
 * never writes, so every document would fail to import.
 */
function nestedTypeOf(
  searchType: SearchType,
  field: SearchField,
  schema: SearchSchema | undefined,
): SearchType | undefined {
  const nested =
    schema === undefined
      ? undefined
      : (nestedReferenceType(schema, field) ??
        localLookupTypeOf(field, schema));
  // Reached only for a field carrying a Role, so an inline reference here
  // stores entries: a Role-less one is an internal reading device, pruned
  // before the writer.
  if (nested === undefined && isInlineReference(field)) {
    throw new Error(
      `Building the collection for “${searchType.name}” needs the search schema its surfaced inline reference “${field.name}” resolves against; pass it as the collection-definition option “schema”.`,
    );
  }
  return nested;
}

/**
 * The Typesense reference declaration a {@link ReferenceField.joinable} field
 * carries, or `undefined` for every other field. All three keys are forced,
 * none is a knob:
 *
 * - **`reference` always targets `.id`.** A reference match hitting more than
 *   one document is a 400, and `id` is the only field the schema guarantees
 *   unique.
 * - **`async_reference: true`.** Without it, a document whose referent is not
 *   indexed yet is rejected with a 400 – and the batch import runs
 *   `throwOnFail: false`, so those would be silently dropped documents.
 *   Documents stream per dataset ([ADR 13](../../../docs/decisions/0013-project-inside-the-batch-per-root-type.md)),
 *   so out-of-order arrival is normal rather than exceptional; the engine
 *   back-fills the reference when the referent lands.
 * - **`cascade_delete: false`.** It defaults to `true`, so a sweep removing a
 *   departed source’s referent documents would delete other sources’ referring
 *   documents with them. Disabling it requires `async_reference`, so the two
 *   travel together.
 *
 * Throws when the type declares a joinable reference the caller gave no schema
 * to resolve the target of – the collection would otherwise come into existence
 * without its reference and 400 on every join query.
 */
function referenceDeclaration(
  searchType: SearchType,
  field: SearchField,
  schema: SearchSchema | undefined,
  collectionNameFor: (searchType: SearchType) => string,
): Record<string, unknown> | undefined {
  if (field.kind !== 'reference' || field.joinable !== true) {
    return undefined;
  }
  if (schema === undefined) {
    throw new Error(
      `Building the collection for “${searchType.name}” needs the search schema its joinable reference “${field.name}” resolves against; pass it as the collection-definition option “schema”.`,
    );
  }
  const target = joinGraph(schema).resolve(searchType, [field.name]);
  if (target === undefined) {
    // A schema WAS given and the edge still does not resolve. The rules that
    // would reject the declaration itself all ran when the schema was built, so
    // what is left is identity: `joinGraph` resolves from the exact declaration
    // object the schema holds, and this is a lookalike – a re-declared type, or
    // one belonging to another schema. Saying “pass the schema” here would send
    // a caller to do the thing they already did.
    throw new Error(
      `Building the collection for “${searchType.name}” cannot resolve its joinable reference “${field.name}”: the given search schema does not declare this exact type. Pass the declaration the schema was built from, not a copy of it.`,
    );
  }
  return {
    reference: `${collectionNameFor(target)}.${ID_FIELD}`,
    async_reference: true,
    cascade_delete: false,
  };
}

/** The physical Typesense fields one declaration produces. */
function typesenseFields(
  searchType: SearchType,
  field: SearchField,
  defaultLocale: string | undefined,
  defaultSortingField: string | undefined,
  schema: SearchSchema | undefined,
  collectionNameFor: (searchType: SearchType) => string,
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
    return [
      ...nestedFields(
        field.name,
        field,
        nested,
        schema as SearchSchema,
        defaultLocale,
      ),
      ...identityCompanionFields(field, schema as SearchSchema),
    ];
  }
  const names = physicalFields(field, schema);
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
      // A reference inheriting a facet policy facets its companion below, and
      // the field itself stays a plain stored value – which is also what keeps
      // a membership filter on it exact (`compileMembership`).
      facet: names.facet === field.name,
      sort: field.sortable ?? false,
      // A `required` field is non-optional; so is the `default_sorting_field`,
      // which Typesense requires to be present. Everything else may be absent.
      optional: field.required !== true && field.name !== defaultSortingField,
      ...referenceDeclaration(searchType, field, schema, collectionNameFor),
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
  // The `${name}_facet` companion of a reference inheriting a facet policy:
  // the admitted subset of the field’s values, and the only one of the two
  // the engine facets. Optional, because a document none of whose values the
  // policy admits carries no companion at all.
  if (names.facet !== undefined && names.facet !== field.name) {
    fields.push({
      name: names.facet,
      type: valueType,
      facet: true,
      optional: true,
    });
  }
  return fields;
}

/**
 * The nested object one inline reference stores, plus one nested Physical Field
 * per field of the type it nests – recursing for a nested field that itself
 * nests (another inline reference, or a
 * {@link ReferenceStrategy.local local} lookup, which stores its endpoint
 * shaped by the target’s own declaration). `searchSchema` rejects inline
 * cycles, so the recursion terminates.
 *
 * **A nested field is indexed exactly when it declares a query Role.** One that
 * declares only `output` keeps `index: false`: stored with its referent, read
 * back with it, costing disk rather than RAM – the same lever the per-language
 * display labels use. `filterable` or `searchable` turns indexing on for that
 * one field, and nothing else.
 *
 * **The parent object must be indexed whenever any descendant is.** Typesense
 * silently ignores an indexed child under an `index: false` parent: no error,
 * no match, every query answering empty. So the parent’s flag is computed from
 * the children rather than declared, and this is the one place that invariant
 * can be got wrong.
 */
function nestedFields(
  prefix: string,
  reference: SearchField,
  nestedType: SearchType,
  schema: SearchSchema,
  defaultLocale: string | undefined,
  withinArray = false,
): CollectionFieldSchema[] {
  const array = reference.array === true;
  // Typesense flattens a nested object, so a value under a multi-valued
  // ancestor arrives as an array however single-valued the declaration is.
  // That only matters for an INDEXED field, whose declared type is checked
  // against what is stored; an unindexed one is stored as-is.
  const flattensToArray = withinArray || array;
  const children: CollectionFieldSchema[] = [];
  // A `local` lookup nests its endpoint’s own document, which carries the `id`
  // that identifies it. The target type does not declare `id` – no type
  // declares its own key – so it is added here or it would be the one stored
  // value the collection never mentions.
  if (nestedType.class !== undefined) {
    children.push({
      name: nestedFieldName(prefix, 'id'),
      type: flattensToArray ? 'string[]' : 'string',
      index: false,
      optional: true,
    });
  }
  for (const field of nestedType.fields) {
    if (isInternalField(field)) {
      continue;
    }
    const deeper = nestedTypeOfNestedField(field, schema);
    if (deeper !== undefined) {
      children.push(
        ...nestedFields(
          nestedFieldName(prefix, field.name),
          field,
          deeper,
          schema,
          defaultLocale,
          flattensToArray,
        ),
        // A nested field that stores an object cannot be filtered as itself,
        // and its own id is a level deeper than a condition can be welded to –
        // an engine welds conditions on an entry's LEAF fields only. Its
        // identity companion is that leaf, so it sits beside the object rather
        // than inside it.
        ...nestedIdentityFields(prefix, field, schema, flattensToArray),
      );
      continue;
    }
    children.push(
      ...nestedLeafFields(prefix, field, defaultLocale, flattensToArray),
    );
  }
  return [
    {
      name: prefix,
      // Flattening applies to an object exactly as it does to a value: a
      // single-valued nesting inside a multi-valued one arrives as a list of
      // objects, so it is only declared `object` where nothing above it is an
      // `object[]`.
      type: flattensToArray ? 'object[]' : 'object',
      // Never hard-coded: see the parent-object rule above.
      index: children.some((child) => child.index !== false),
      optional: reference.required !== true,
    },
    ...children,
  ];
}

/**
 * The **identity companion** of an inline reference: the flat field holding the
 * ids its entries reference, which the engine filters and facets in place of
 * the nested object it cannot. Empty for an inline reference declaring no
 * `identity` – a display-only nesting keeps costing no RAM.
 *
 * A second, narrowed field joins it where the target declares a facet policy,
 * exactly as it does for a top-level facetable reference: the facet then reads
 * the admitted subset, so an excluded id is never seen by the engine rather
 * than merely unlabelled.
 */
function identityCompanionFields(
  field: SearchField,
  schema: SearchSchema,
): CollectionFieldSchema[] {
  const names = physicalFields(field, schema);
  if (names.identity === undefined) {
    return [];
  }
  const fields: CollectionFieldSchema[] = [
    {
      name: names.identity,
      type: 'string[]',
      facet: names.facet === names.identity,
      optional: true,
    },
  ];
  if (names.facet !== undefined && names.facet !== names.identity) {
    fields.push({
      name: names.facet,
      type: 'string[]',
      facet: true,
      optional: true,
    });
  }
  return fields;
}

/** The identity companion of a nested field that stores an object: a flat leaf
 *  beside it, holding the ids a filter welds on. Empty for a nested field that
 *  declares no query Role, which needs none. */
function nestedIdentityFields(
  prefix: string,
  field: SearchField,
  schema: SearchSchema,
  flattensToArray: boolean,
): CollectionFieldSchema[] {
  const names = physicalFields(field, schema);
  if (names.identity === undefined) {
    return [];
  }
  return [
    {
      name: nestedFieldName(prefix, names.identity),
      type: flattensToArray ? 'string[]' : 'string',
      index: true,
      optional: true,
    },
  ];
}

/** The type a *nested* field itself nests: another inline reference’s type, or
 *  the Root Type a {@link ReferenceStrategy.local local} lookup projects its
 *  endpoint through. */
function nestedTypeOfNestedField(
  field: SearchField,
  schema: SearchSchema,
): SearchType | undefined {
  return nestedReferenceType(schema, field) ?? localLookupTypeOf(field, schema);
}

/**
 * The Physical Fields one non-nesting nested field contributes: exactly what
 * the projection writes under the referent’s prefix, so the collection and the
 * document cannot disagree.
 *
 * A nested `text` field stores its display values as a root one does – one
 * `${name}_<lang>` per present language, matched by a single pattern field,
 * never indexed – plus a folded search companion per locale when it is
 * `searchable`. Anything undeclared here would still arrive in the document,
 * and Typesense indexes what it is not told to leave alone, so the fanout is
 * enumerated rather than left to inference.
 */
function nestedLeafFields(
  prefix: string,
  field: SearchField,
  defaultLocale: string | undefined,
  flattensToArray: boolean,
): CollectionFieldSchema[] {
  const names = physicalFields(field);
  const searchString = flattensToArray ? 'string[]' : 'string';
  const fields: CollectionFieldSchema[] = [];
  if (field.kind === 'text') {
    const pattern = displayFieldPattern(field);
    if (pattern !== undefined) {
      // Display values are never indexed, whatever Roles the field declares:
      // search hits the folded companions below, so the display copies stay on
      // disk with every language they carry.
      fields.push({
        name: nestedFieldName(prefix, pattern),
        type: 'string',
        index: false,
        optional: true,
      });
    }
    fields.push(
      ...names.search.map((name, index): CollectionFieldSchema => {
        const locale =
          field.locales[index] === 'und' ? defaultLocale : field.locales[index];
        return {
          name: nestedFieldName(prefix, name),
          type: searchString,
          optional: true,
          ...(locale !== undefined && { stem: true, locale }),
        };
      }),
    );
    return fields;
  }
  // A nested field can be `filterable` or `searchable`, never `facetable` or
  // `sortable` (`searchSchema`), so `filterable` is what indexes the value
  // itself – its search companion below indexes on its own account.
  const indexed = field.filterable === true;
  const valueType = typesenseValueType(field);
  fields.push({
    name: nestedFieldName(prefix, field.name),
    type: indexed && flattensToArray ? arrayValueType(valueType) : valueType,
    index: indexed,
    // Always optional: `required` is a promise about the *referent* (this value
    // is on every referent), while Typesense’s flag is about the document.
    // Under a multi-valued reference those are different claims, and only the
    // referent-level one is the declaration’s.
    optional: true,
  });
  for (const name of names.search) {
    fields.push({
      name: nestedFieldName(prefix, name),
      type: searchString,
      optional: true,
    });
  }
  return fields;
}

/** The Typesense field type for a non-localized field, from its `kind`. 64-bit
 *  integers (and dates, stored as Unix seconds) so large counts never overflow. */
/**
 * The array form of a value type, for a nested field that an ancestor’s
 * `object[]` flattens into a list. Only an **indexed** field needs it: Typesense
 * checks a declared type against what is stored, and a value under a
 * multi-valued ancestor arrives as an array however single-valued its own
 * declaration is. Enumerated rather than string-appended so an invalid
 * combination cannot be built.
 */
function arrayValueType(type: ValueType): CollectionFieldSchema['type'] {
  switch (type) {
    case 'string':
      return 'string[]';
    case 'int64':
      return 'int64[]';
    case 'float':
      return 'float[]';
    case 'bool':
      return 'bool[]';
    // Already a list: a multi-valued declaration under a multi-valued ancestor
    // flattens no further.
    case 'string[]':
      return 'string[]';
  }
}

/**
 * The value types a declaration can produce. Narrower than Typesense’s whole
 * vocabulary on purpose: it makes {@link arrayValueType} exhaustive, so a kind
 * added later fails to compile rather than falling through a default that
 * silently returns the scalar type for an indexed list.
 */
type ValueType = 'string' | 'string[]' | 'int64' | 'float' | 'bool';

function typesenseValueType(field: SearchField): ValueType {
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
