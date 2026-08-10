import {
  GraphQLBoolean,
  GraphQLEnumType,
  GraphQLFloat,
  GraphQLInputObjectType,
  GraphQLInt,
  GraphQLList,
  GraphQLNonNull,
  GraphQLObjectType,
  GraphQLSchema,
  GraphQLString,
  printSchema,
  type GraphQLEnumValueConfigMap,
  type GraphQLFieldConfig,
  type GraphQLInputFieldConfig,
  type GraphQLInputType,
  type GraphQLOutputType,
} from 'graphql';
import {
  type Criterion,
  type Filter,
  type LocalizedValue,
  type RootType,
  type SearchEngine,
  type SearchField,
  type SearchQuery,
  type SearchSchema,
  type SearchType,
} from '@lde/search';
import {
  AND_KEY,
  facetableFields,
  filterableFields,
  filterOn,
  filterOperatorFor,
  ID_FIELD,
  OR_KEY,
  isRangeFacet,
  nestedReferenceType,
  outputFields,
  pageForOffset,
  sortableFields,
  unixSecondsToIso,
} from '@lde/search/adapter';
import {
  defaultLanguageOrder,
  toLanguageStrings,
  type LanguageOrder,
} from './language.js';
import { createFacetLoader, type FacetLoader } from './facet-batch.js';

/** Populated per request by the transport; no framework type appears here. */
export interface SearchContext {
  /** The deployment’s engine, bound to the whole {@link SearchSchema} at
   *  construction; the resolvers pass each root field’s search type per call
   *  and the engine routes it to its collection. */
  readonly engine: SearchEngine;
  /** Parsed, ordered `Accept-Language`; drives locale selection and output order. */
  readonly acceptLanguage: readonly string[];
  /**
   * Called once per affected facet field when its computation fails – for a
   * failed facet query only that query's fields, for a failed batch dispatch
   * every selected field. The affected facets degrade to empty lists (a
   * supplementary facet must not fail the whole query); supply this to log
   * the cause. Optional – omit to swallow silently.
   */
  readonly onFacetError?: (field: string, error: unknown) => void;
}

/** Per-root-type fine-tuning. The type’s name comes from the {@link SearchType}
 *  itself (`name`); options exist only for what has a sensible default. */
export interface SearchTypeOptions {
  /** Root query field; defaults to the lowercased plural of the type’s `name`
   *  (e.g. `Dataset` → `datasets`). */
  readonly queryField?: string;
  /** Consumer policy applied to every query of this type (default status, sort,
   *  tie-breaks). */
  readonly queryDefaults?: (
    query: SearchQuery,
    context: SearchContext,
  ) => SearchQuery;
}

export interface BuildGraphQLSchemaOptions {
  /** Optional fine-tuning per root type, keyed by the {@link SearchType}
   *  `name` (the logical API name, e.g. `Dataset`) – the key a consumer knows
   *  the type by. A type without an entry gets the defaults. */
  readonly types?: Readonly<Record<string, SearchTypeOptions>>;
  /** Output-language ordering; defaults to Accept-Language-first, `und` last. */
  readonly languageOrder?: LanguageOrder;
  /** Upper bound for the `perPage` argument (default 100). A request outside
   *  `1 ≤ perPage ≤ maxPerPage` or with `page < 1` is rejected with a clear
   *  error instead of reaching the engine. */
  readonly maxPerPage?: number;
}

type Source = Record<string, unknown>;

const nonNullListOf = (type: GraphQLOutputType): GraphQLOutputType =>
  new GraphQLNonNull(new GraphQLList(new GraphQLNonNull(type)));

const scalarOutput = (
  scalar: GraphQLOutputType,
  field: SearchField,
): GraphQLOutputType =>
  field.required === true ? new GraphQLNonNull(scalar) : scalar;

/** SCREAMING_SNAKE_CASE for an enum value name, e.g. `datePosted` → `DATE_POSTED`. */
function screamingSnake(name: string): string {
  return name.replace(/([a-z0-9])([A-Z])/g, '$1_$2').toUpperCase();
}

/**
 * Construct an executable GraphQL schema from the whole {@link SearchSchema} at
 * runtime – no codegen, no SDL artifact. One root query field per
 * {@link SearchType} (e.g. `datasets`, `people`), each searchable in its own
 * way through its own output/`where`/`orderBy`/facet types, while the shared
 * types (`LanguageString`, buckets, filter inputs, reference types) are created
 * once. One generic resolver per root field maps the arguments to a
 * {@link SearchQuery}, calls `context.engine`, and maps the result back; the
 * field model only parameterises data.
 */
export function buildGraphQLSchema(
  schema: SearchSchema,
  options: BuildGraphQLSchemaOptions = {},
): GraphQLSchema {
  const languageOrder = options.languageOrder ?? defaultLanguageOrder;
  const maxPerPage = options.maxPerPage ?? 100;
  const rootTypeNames = new Set(
    [...schema.values()].map((searchType) => searchType.name),
  );
  for (const name of Object.keys(options.types ?? {})) {
    if (!rootTypeNames.has(name)) {
      throw new Error(
        `Options given for type “${name}”, which is not in the search schema.`,
      );
    }
  }

  const languageString = new GraphQLObjectType({
    name: 'LanguageString',
    fields: {
      language: { type: GraphQLString },
      value: { type: new GraphQLNonNull(GraphQLString) },
    },
  });
  // A plain value facet bucket: a selection key, its count, and (for reference
  // facets) the engine-resolved data label; null for token/free-string facets
  // whose display the consumer owns.
  const valueBucket = new GraphQLObjectType({
    name: 'ValueBucket',
    fields: {
      value: { type: new GraphQLNonNull(GraphQLString) },
      count: { type: new GraphQLNonNull(GraphQLInt) },
      label: {
        type: new GraphQLList(new GraphQLNonNull(languageString)),
        resolve: (bucket: Source, _args: unknown, context: SearchContext) => {
          const label = bucket.label as LocalizedValue | undefined;
          return label
            ? toLanguageStrings(label, context.acceptLanguage, languageOrder)
            : null;
        },
      },
    },
  });
  // A numeric range-facet bin: half-open `[min, max)` bounds (max null on an
  // open-ended top bin) and the count of documents in it.
  const rangeBucket = new GraphQLObjectType({
    name: 'RangeBucket',
    fields: {
      min: { type: GraphQLFloat },
      max: { type: GraphQLFloat },
      count: { type: new GraphQLNonNull(GraphQLInt) },
    },
  });
  // A boolean-facet bucket: the value as a real boolean, so the bucket a client
  // selects round-trips straight into the `is` filter that selects it. No label
  // – a boolean has no data label to resolve, and the sensible rendering (“with
  // an image” / “without one”) is knowable only by the consumer.
  const booleanBucket = new GraphQLObjectType({
    name: 'BooleanBucket',
    fields: {
      value: {
        type: new GraphQLNonNull(GraphQLBoolean),
        resolve: (bucket: Source) => bucket.is,
      },
      count: { type: new GraphQLNonNull(GraphQLInt) },
    },
  });
  // The pagination actually applied (after queryDefaults), shared across every
  // ‹Type›SearchResult so one client pager fragment serves all root types.
  const paginationType = new GraphQLObjectType({
    name: 'Pagination',
    fields: {
      total: { type: new GraphQLNonNull(GraphQLInt) },
      page: { type: new GraphQLNonNull(GraphQLInt) },
      perPage: { type: new GraphQLNonNull(GraphQLInt) },
    },
  });
  const sortDirection = new GraphQLEnumType({
    name: 'SortDirection',
    values: { ASC: { value: 'asc' }, DESC: { value: 'desc' } },
  });
  const stringFilter = new GraphQLInputObjectType({
    name: 'StringFilter',
    fields: {
      in: { type: new GraphQLList(new GraphQLNonNull(GraphQLString)) },
    },
  });
  const intRange = rangeInput('IntRange', GraphQLInt);
  const floatRange = rangeInput('FloatRange', GraphQLFloat);
  const dateRange = rangeInput('DateRange', GraphQLString);

  const labelList = (
    resolveLabel: (source: Source) => LocalizedValue | undefined,
  ) => ({
    type: nonNullListOf(languageString),
    resolve: (source: Source, _args: unknown, context: SearchContext) => {
      const value = resolveLabel(source);
      return value
        ? toLanguageStrings(value, context.acceptLanguage, languageOrder)
        : [];
    },
  });

  // Duplicate root type names cannot occur: SearchSchema is branded, so
  // searchSchema() – which rejects duplicates – is the only constructor.

  // One reference type per referenced shape, shared across every root type and
  // reused by every field (Person and CreativeWork both referencing Agent yield
  // one Agent type). A reference may name a root type – the `labelOnly` way to
  // carry an id plus a label resolved from that root’s collection (`creator` →
  // `Person`) – but GraphQL type names must be unique, so such a reference is
  // served under `‹Name›Reference` instead. An `inline` reference can never
  // collide: searchSchema resolves its typeName to a declared Reference Type
  // and rejects duplicate names schema-wide.
  const referenceTypes = new Map<string, GraphQLObjectType>();
  const takenTypeNames = new Set(rootTypeNames);

  /**
   * Register the GraphQL type one reference field is served as, once per
   * referenced shape. A **surfaced inline** reference is served as the nested
   * object its Reference Type declares – its own `output` fields, configured by
   * exactly the same per-kind rules a root type’s fields are – so the response
   * shape matches the data’s shape. Its `id` is nullable: a referent needs no
   * identity, and a blank-node one nests without one. Every other reference
   * stays the id-plus-label pair its strategy carries.
   */
  function registerReferenceType(field: SearchField, owner: SearchType): void {
    if (
      field.kind !== 'reference' ||
      field.ref === undefined ||
      referenceTypes.has(field.ref.typeName)
    ) {
      return;
    }
    const { typeName } = field.ref;
    const graphQLName = rootTypeNames.has(typeName)
      ? `${typeName}Reference`
      : typeName;
    if (takenTypeNames.has(graphQLName)) {
      throw new Error(
        `Reference type “${typeName}” (field “${field.name}” of “${owner.name}”) would be served as “${graphQLName}”, which collides with another type name; rename one.`,
      );
    }
    takenTypeNames.add(graphQLName);
    const nested = nestedReferenceType(schema, field);
    referenceTypes.set(
      typeName,
      new GraphQLObjectType({
        name: graphQLName,
        // A thunk, so a Reference Type nesting another one resolves whatever
        // the registration order is (the graph is acyclic by searchSchema).
        fields: (): Record<
          string,
          GraphQLFieldConfig<Source, SearchContext>
        > =>
          nested === undefined
            ? {
                id: { type: new GraphQLNonNull(GraphQLString) },
                // `label`, the same word the label source declares and a
                // reference facet’s bucket carries: one resolved label, one
                // name for it wherever it surfaces.
                label: labelList(
                  (source) => source.label as LocalizedValue | undefined,
                ),
              }
            : {
                id: { type: GraphQLString },
                ...Object.fromEntries(
                  outputFields(nested).map((nestedField) => [
                    nestedField.name,
                    outputFieldConfig(nestedField),
                  ]),
                ),
              },
      }),
    );
    if (nested === undefined) {
      return;
    }
    // A nested reference type’s own surfaced references are types too; register
    // them now, so every type exists before the thunks above are called.
    for (const nestedField of outputFields(nested)) {
      registerReferenceType(nestedField, nested);
    }
  }

  for (const searchType of schema.values()) {
    for (const field of outputFields(searchType)) {
      registerReferenceType(field, searchType);
    }
  }

  function outputFieldConfig(
    field: SearchField,
  ): GraphQLFieldConfig<Source, SearchContext> {
    switch (field.kind) {
      case 'text':
        return labelList(
          (source) => source[field.name] as LocalizedValue | undefined,
        );
      case 'keyword':
        return field.array === true
          ? {
              type: nonNullListOf(GraphQLString),
              resolve: (s) => s[field.name] ?? [],
            }
          : { type: scalarOutput(GraphQLString, field) };
      case 'reference': {
        const referenceType = referenceTypes.get(field.ref?.typeName ?? '')!;
        return field.array === true
          ? {
              type: nonNullListOf(referenceType),
              resolve: (s) => s[field.name] ?? [],
            }
          : {
              type:
                field.required === true
                  ? new GraphQLNonNull(referenceType)
                  : referenceType,
            };
      }
      case 'integer':
        return { type: scalarOutput(GraphQLInt, field) };
      case 'number':
        return { type: scalarOutput(GraphQLFloat, field) };
      case 'date':
        // Stored as Unix seconds (int64); the surface serves ISO 8601 (ADR 4).
        return {
          type: scalarOutput(GraphQLString, field),
          resolve: (source) => {
            const value = source[field.name];
            return typeof value === 'number'
              ? unixSecondsToIso(value)
              : (value ?? null);
          },
        };
      case 'boolean':
        return {
          type: new GraphQLNonNull(GraphQLBoolean),
          resolve: (source) => source[field.name] === true,
        };
    }
  }

  function whereFieldType(field: SearchField): GraphQLInputType {
    switch (filterOperatorFor(field.kind)) {
      case 'in':
        return stringFilter;
      case 'range':
        return field.kind === 'integer'
          ? intRange
          : field.kind === 'number'
            ? floatRange
            : dateRange;
      default:
        return GraphQLBoolean;
    }
  }

  /** The root query field for one {@link RootType}, with its derived types. */
  function rootField(
    searchType: RootType,
    typeOptions: SearchTypeOptions | undefined,
  ): GraphQLFieldConfig<Source, SearchContext> {
    const typeName = searchType.name;

    const outputType = new GraphQLObjectType({
      name: typeName,
      fields: () => {
        const fields: Record<
          string,
          GraphQLFieldConfig<Source, SearchContext>
        > = {
          id: { type: new GraphQLNonNull(GraphQLString) },
        };
        for (const field of outputFields(searchType)) {
          fields[field.name] = outputFieldConfig(field);
        }
        return fields;
      },
    });

    // Every type is filterable on `id`, so the input always has at least one
    // field and always exists – no type is unaddressable by IRI, whatever it
    // declares.
    const filterable = filterableFields(searchType);
    /**
     * One key per filterable field (plus the undeclared `id`), each typed by its
     * OWN kind – so the operator a key accepts is fixed by the field it names,
     * and a range on a keyword field cannot be written at all. This is the
     * single vocabulary every level of `where` is built from: the same keys
     * appear on the clause and on a criterion, so a field is never named a
     * second way.
     */
    const fieldKeys = (): Record<string, GraphQLInputFieldConfig> => {
      const fields: Record<string, GraphQLInputFieldConfig> = {
        [ID_FIELD]: { type: stringFilter },
      };
      for (const field of filterable) {
        fields[field.name] = { type: whereFieldType(field) };
      }
      return fields;
    };

    // A criterion is an ATOM: exactly one field, enforced by `@oneOf`. That is
    // what keeps `where` a flat conjunction of disjunctions – a criterion that
    // could carry two keys would be a conjunction nested inside an `or`, and
    // skip-own-filter (ADR 5) has no answer for a clause buried inside another.
    const criterionInput = new GraphQLInputObjectType({
      name: `${typeName}Criterion`,
      description:
        'A condition on exactly one field. Used inside `or`, where the criteria are alternatives.',
      isOneOf: true,
      fields: fieldKeys,
    });
    const orKey: GraphQLInputFieldConfig = {
      type: new GraphQLList(new GraphQLNonNull(criterionInput)),
      description:
        'A disjunction: a document matches when ANY of these criteria holds. Combined with the sibling keys by AND, so it widens across fields without widening the query as a whole.',
    };
    // `and` carries further `Where`s rather than a separate clause type. Safe to
    // be recursive: a conjunction inside a conjunction FLATTENS, and the one
    // shape that would not – an `and` inside an `or` – is unreachable, because
    // `or` holds only `@oneOf` criteria. So `where` stays a flat conjunction of
    // disjunctions at any nesting depth, and a reader meets one input type
    // instead of two near-identical ones.
    const whereInput: GraphQLInputObjectType = new GraphQLInputObjectType({
      name: `${typeName}Where`,
      description:
        'Sibling keys are combined with AND. Use `or` for a disjunction, and `and` when a query needs more than one of them.',
      fields: () => ({
        ...fieldKeys(),
        [OR_KEY]: orKey,
        [AND_KEY]: {
          type: new GraphQLList(new GraphQLNonNull(whereInput)),
          description:
            'Further groups of conditions, all of which apply. The way to carry a second `or` disjunction alongside the first.',
        },
      }),
    });

    const sortValues: GraphQLEnumValueConfigMap = {
      RELEVANCE: { value: 'relevance' },
    };
    for (const field of sortableFields(searchType)) {
      sortValues[screamingSnake(field.name)] = { value: field.name };
    }
    const sortField = new GraphQLEnumType({
      name: `${typeName}SortField`,
      values: sortValues,
    });
    const orderByInput = new GraphQLInputObjectType({
      name: `${typeName}OrderBy`,
      fields: {
        field: { type: new GraphQLNonNull(sortField) },
        direction: {
          type: new GraphQLNonNull(sortDirection),
          defaultValue: 'desc',
        },
      },
    });

    // Keyed facets object: one field per facetable field, typed by its kind
    // (range fields → [RangeBucket!], boolean fields → [BooleanBucket!], else
    // [ValueBucket!]). Only the selected
    // fields are resolved (GraphQL prunes the rest), so the selection IS the
    // request; how they are computed – skip-own-filter, batched into one
    // engine dispatch – lives in facet-batch.ts.
    // Like `where`, omitted entirely for a type with no facetable fields (a
    // GraphQL object type must have at least one field).
    const facetable = facetableFields(searchType);
    const facetsType =
      facetable.length === 0 ? undefined : facetsTypeFor(typeName, facetable);

    const resultType = new GraphQLObjectType({
      name: `${typeName}SearchResult`,
      fields: {
        items: { type: nonNullListOf(outputType) },
        pagination: { type: new GraphQLNonNull(paginationType) },
        // Resolved lazily, per selected key (skip-own-filter); the result object
        // (which carries the per-request facet loader) is the facets source.
        ...(facetsType && {
          facets: {
            type: new GraphQLNonNull(facetsType),
            resolve: (source: Source) => source,
          },
        }),
      },
    });

    return {
      type: new GraphQLNonNull(resultType),
      args: {
        query: { type: GraphQLString },
        where: { type: whereInput },
        orderBy: { type: orderByInput },
        page: { type: GraphQLInt, defaultValue: 1 },
        perPage: { type: GraphQLInt, defaultValue: 20 },
      },
      resolve: async (_source, args, context: SearchContext) => {
        const built = argsToQuery(
          args as QueryArgs,
          context,
          searchType,
          maxPerPage,
        );
        const finalQuery = typeOptions?.queryDefaults
          ? typeOptions.queryDefaults(built, context)
          : built;
        // Items + total only; facets are resolved lazily per selected key.
        const result = await context.engine.search(searchType, {
          ...finalQuery,
          facets: [],
        });
        return {
          items: result.hits.map((hit) => ({ id: hit.id, ...hit.document })),
          pagination: {
            total: result.total,
            page: pageForOffset(finalQuery.offset, finalQuery.limit),
            perPage: finalQuery.limit,
          },
          // Carried for the facet field resolvers (see facet-batch.ts).
          loadFacet: createFacetLoader(
            context.engine,
            searchType,
            finalQuery,
            context.onFacetError,
          ),
        };
      },
    };
  }

  /** The bucket type a facet’s kind earns: bins for a range facet, a real
   *  boolean for a boolean one, a keyed value otherwise. */
  function bucketTypeFor(field: SearchField): GraphQLObjectType {
    if (isRangeFacet(field)) return rangeBucket;
    return field.kind === 'boolean' ? booleanBucket : valueBucket;
  }

  /** The keyed facets object for one type (only called with ≥ 1 facetable field). */
  function facetsTypeFor(
    typeName: string,
    facetable: readonly SearchField[],
  ): GraphQLObjectType {
    return new GraphQLObjectType({
      name: `${typeName}Facets`,
      fields: () => {
        const fields: Record<
          string,
          GraphQLFieldConfig<Source, SearchContext>
        > = {};
        for (const field of facetable) {
          fields[field.name] = {
            type: nonNullListOf(bucketTypeFor(field)),
            // The skip-own-filter query building, the batching into one
            // engine dispatch and the degrade-to-[] error handling all live
            // in the loader (facet-batch.ts).
            resolve: (source: Source) =>
              (source.loadFacet as FacetLoader)(field.name),
          };
        }
        return fields;
      },
    });
  }

  const queryFields: Record<
    string,
    GraphQLFieldConfig<Source, SearchContext>
  > = {};
  for (const searchType of schema.values()) {
    const typeOptions = options.types?.[searchType.name];
    const typeName = searchType.name;
    const queryField =
      typeOptions?.queryField ??
      `${typeName.charAt(0).toLowerCase()}${typeName.slice(1)}s`;
    if (queryField in queryFields) {
      throw new Error(
        `Duplicate root query field “${queryField}”; set queryField to disambiguate.`,
      );
    }
    queryFields[queryField] = rootField(searchType, typeOptions);
  }

  return new GraphQLSchema({
    query: new GraphQLObjectType({ name: 'Query', fields: queryFields }),
  });
}

/**
 * The SDL of the built schema. Not a shipped artifact – a consumer uses it for an
 * optional CI snapshot test over its own schema, catching accidental breaking
 * changes to its frozen contract (including a `buildGraphQLSchema` change in a
 * future version of this library silently altering it).
 */
export function printGraphQLSchema(
  schema: SearchSchema,
  options: BuildGraphQLSchemaOptions = {},
): string {
  return printSchema(buildGraphQLSchema(schema, options));
}

interface QueryArgs {
  readonly query?: string;
  readonly where?: Record<string, unknown>;
  readonly orderBy?: { field: string; direction: 'asc' | 'desc' };
  readonly page?: number;
  readonly perPage?: number;
}

/** Pure args → {@link SearchQuery} mapping. Rejects out-of-bounds paging
 *  (`page < 1`, `perPage` outside `1..maxPerPage`) with a clear error – a
 *  negative offset or an unbounded page size must not reach the engine. */
function argsToQuery(
  args: QueryArgs,
  context: SearchContext,
  searchType: SearchType,
  maxPerPage: number,
): SearchQuery {
  const perPage = args.perPage ?? 20;
  const page = args.page ?? 1;
  if (page < 1) {
    throw new Error(`page must be at least 1; got ${page}.`);
  }
  // perPage: 0 is a legitimate facet-only query (no hits, page pins to 1).
  if (perPage < 0 || perPage > maxPerPage) {
    throw new Error(
      `perPage must be between 0 and ${maxPerPage}; got ${perPage}.`,
    );
  }
  return {
    text: args.query,
    where: whereToFilters(args.where, searchType),
    orderBy: args.orderBy
      ? [{ field: args.orderBy.field, direction: args.orderBy.direction }]
      : [],
    limit: perPage,
    offset: (page - 1) * perPage,
    // Facets are requested per-key by the facets resolver, not via an arg.
    facets: [],
    locale: context.acceptLanguage[0] ?? 'und',
  };
}

function whereToFilters(
  where: Record<string, unknown> | undefined,
  searchType: SearchType,
): Filter[] {
  // `== null` deliberately: an explicit `where: null` is as absent as an omitted
  // one, and reading keys off it would throw.
  if (where == null) {
    return [];
  }
  const filters = criteriaOf(where, searchType).map(filterOn);
  // Sibling field keys AND, so each becomes a one-criterion filter of its own,
  // while `or` becomes a SINGLE filter carrying every alternative. That is the
  // whole AND/OR mapping: which bucket a criterion lands in, never a combinator
  // inferred from how deeply it is nested.
  const alternatives = (
    (where[OR_KEY] as readonly Record<string, unknown>[] | null) ?? []
  ).flatMap((criterion) => criteriaOf(criterion, searchType));
  if (alternatives.length > 0) {
    filters.push({ or: alternatives });
  }
  // `and` carries further groups, each contributing its own filters – which is
  // how a query states a second `or` alongside the first. Recursing keeps the
  // result flat: nested conjunctions collapse into this one list, and an `and`
  // can never sit inside an `or` (which holds only criteria).
  for (const nested of (where[AND_KEY] as
    readonly Record<string, unknown>[] | null) ?? []) {
    filters.push(...whereToFilters(nested, searchType));
  }
  return filters;
}

/**
 * The criteria a keyed object carries, in declaration order. A `Criterion` is
 * `@oneOf`, so it yields exactly one; a `Where`/`Clause` yields one per field
 * key it sets. `id` is read first: no type declares it, so the field loop below
 * never sees it.
 */
function criteriaOf(
  keyed: Record<string, unknown>,
  searchType: SearchType,
): Criterion[] {
  const criteria: Criterion[] = [];
  const id = keyed[ID_FIELD] as { in?: string[] } | undefined | null;
  if (id !== undefined && id !== null) {
    criteria.push({ field: ID_FIELD, in: id.in ?? [] });
  }
  for (const field of filterableFields(searchType)) {
    const value = keyed[field.name];
    if (value === undefined || value === null) {
      continue;
    }
    switch (filterOperatorFor(field.kind)) {
      case 'in':
        criteria.push({
          field: field.name,
          in: (value as { in?: string[] }).in ?? [],
        });
        break;
      case 'range': {
        const range = value as { min?: number | string; max?: number | string };
        criteria.push({
          field: field.name,
          range: { min: range.min, max: range.max },
        });
        break;
      }
      default:
        criteria.push({ field: field.name, is: value as boolean });
    }
  }
  return criteria;
}

function rangeInput(
  name: string,
  bound: typeof GraphQLInt | typeof GraphQLFloat | typeof GraphQLString,
): GraphQLInputObjectType {
  return new GraphQLInputObjectType({
    name,
    fields: { min: { type: bound }, max: { type: bound } },
  });
}
