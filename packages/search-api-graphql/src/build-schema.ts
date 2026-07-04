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
  facetableFields,
  filterableFields,
  filterOperatorFor,
  isRangeFacet,
  outputFields,
  pageForOffset,
  sortableFields,
  unixSecondsToIso,
  type Filter,
  type LocalizedValue,
  type SearchEngine,
  type SearchField,
  type SearchQuery,
  type SearchSchema,
  type SearchType,
} from '@lde/search';
import {
  defaultLanguageOrder,
  toLanguageStrings,
  type LanguageOrder,
} from './language.js';

/** Populated per request by the transport; no framework type appears here. */
export interface SearchContext {
  readonly engine: SearchEngine;
  /** Parsed, ordered `Accept-Language`; drives locale selection and output order. */
  readonly acceptLanguage: readonly string[];
  /**
   * Called when a single facet's computation fails. The facet degrades to an
   * empty list (a supplementary facet must not fail the whole query); supply
   * this to log the cause. Optional — omit to swallow silently.
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
  /** Optional fine-tuning per root type, keyed by type IRI (the
   *  {@link SearchType} `type`). A type without an entry gets the defaults. */
  readonly types?: Readonly<Record<string, SearchTypeOptions>>;
  /** Output-language ordering; defaults to Accept-Language-first, `und` last. */
  readonly languageOrder?: LanguageOrder;
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
 * runtime — no codegen, no SDL artifact. One root query field per
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
  for (const typeIri of Object.keys(options.types ?? {})) {
    if (!schema.has(typeIri)) {
      throw new Error(
        `Options given for type “${typeIri}”, which is not in the search schema.`,
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

  // Root type names and reference type names share the GraphQL type namespace;
  // catch collisions here with a clear message instead of graphql-js's generic
  // duplicately-named-types error at schema construction.
  const rootTypeNames = new Set<string>();
  for (const searchType of schema.values()) {
    if (rootTypeNames.has(searchType.name)) {
      throw new Error(
        `Duplicate root type name “${searchType.name}”; every SearchType needs a unique name.`,
      );
    }
    rootTypeNames.add(searchType.name);
  }

  // One reference type per referenced shape, shared across every root type and
  // reused by every field (Person and CreativeWork both referencing Agent yield
  // one Agent type).
  const referenceTypes = new Map<string, GraphQLObjectType>();
  for (const searchType of schema.values()) {
    for (const field of outputFields(searchType)) {
      if (field.kind !== 'reference' || field.ref === undefined) {
        continue;
      }
      const { typeName } = field.ref;
      if (rootTypeNames.has(typeName)) {
        throw new Error(
          `Reference type name “${typeName}” (field “${field.name}” of “${searchType.name}”) collides with a root type of the same name; rename one — a reference does not resolve to a root type.`,
        );
      }
      if (!referenceTypes.has(typeName)) {
        referenceTypes.set(
          typeName,
          new GraphQLObjectType({
            name: typeName,
            fields: {
              id: { type: new GraphQLNonNull(GraphQLString) },
              name: labelList(
                (source) => source.label as LocalizedValue | undefined,
              ),
            },
          }),
        );
      }
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

  /** The root query field for one {@link SearchType}, with its derived types. */
  function rootField(
    searchType: SearchType,
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

    // A GraphQL input object must have at least one field, so a type with no
    // filterable fields gets no `where` arg at all rather than an invalid
    // empty input.
    const filterable = filterableFields(searchType);
    const whereInput =
      filterable.length === 0
        ? undefined
        : new GraphQLInputObjectType({
            name: `${typeName}Where`,
            fields: () => {
              const fields: Record<string, GraphQLInputFieldConfig> = {};
              for (const field of filterable) {
                fields[field.name] = { type: whereFieldType(field) };
              }
              return fields;
            },
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
    // (range fields → [RangeBucket!], else [ValueBucket!]). Each field's resolver
    // computes that facet with its OWN where-filter removed (skip-own-filter), so a
    // multi-select facet still lists its other options; only the selected fields
    // are resolved (GraphQL prunes the rest), so the selection IS the request.
    // Like `where`, omitted entirely for a type with no facetable fields (a
    // GraphQL object type must have at least one field).
    const facetable = facetableFields(searchType);
    const facetsType =
      facetable.length === 0
        ? undefined
        : facetsTypeFor(searchType, typeName, facetable);

    const resultType = new GraphQLObjectType({
      name: `${typeName}SearchResult`,
      fields: {
        items: { type: nonNullListOf(outputType) },
        total: { type: new GraphQLNonNull(GraphQLInt) },
        page: { type: new GraphQLNonNull(GraphQLInt) },
        perPage: { type: new GraphQLNonNull(GraphQLInt) },
        // Resolved lazily, per selected key (skip-own-filter); the result object
        // (which carries the resolved `query`) is the facets source.
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
        ...(whereInput && { where: { type: whereInput } }),
        orderBy: { type: orderByInput },
        page: { type: GraphQLInt, defaultValue: 1 },
        perPage: { type: GraphQLInt, defaultValue: 20 },
      },
      resolve: async (_source, args, context: SearchContext) => {
        const built = argsToQuery(args as QueryArgs, context, searchType);
        const finalQuery = typeOptions?.queryDefaults
          ? typeOptions.queryDefaults(built, context)
          : built;
        // Items + total only; facets are resolved lazily per selected key.
        const result = await context.engine.search(
          { ...finalQuery, facets: [] },
          searchType,
        );
        return {
          items: result.hits.map((hit) => ({ id: hit.id, ...hit.document })),
          total: result.total,
          page: pageForOffset(finalQuery.offset, finalQuery.limit),
          perPage: finalQuery.limit,
          // Carried for the facets resolver (skip-own-filter per key).
          query: finalQuery,
        };
      },
    };
  }

  /** The keyed facets object for one type (only called with ≥ 1 facetable field). */
  function facetsTypeFor(
    searchType: SearchType,
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
            type: nonNullListOf(
              isRangeFacet(field) ? rangeBucket : valueBucket,
            ),
            resolve: async (
              source: Source,
              _args: unknown,
              context: SearchContext,
            ) => {
              const query = source.query as SearchQuery;
              // Drop this facet's own filter so its other options still count
              // (a removed `status` filter also drops the valid-only default, so
              // the status facet counts across every status).
              const facetQuery: SearchQuery = {
                ...query,
                where: query.where.filter(
                  (filter) => filter.field !== field.name,
                ),
                facets: [field.name],
                limit: 0,
                offset: 0,
              };
              // A facet is supplementary: degrade a failed facet to an empty list
              // rather than failing the whole query (which would null the non-null
              // result and discard the items + every other facet).
              try {
                const result = await context.engine.search(
                  facetQuery,
                  searchType,
                );
                return result.facets[field.name] ?? [];
              } catch (error) {
                context.onFacetError?.(field.name, error);
                return [];
              }
            },
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
    const typeOptions = options.types?.[searchType.type];
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
 * The SDL of the built schema. Not a shipped artifact — a consumer uses it for an
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

/** Pure args → {@link SearchQuery} mapping. */
function argsToQuery(
  args: QueryArgs,
  context: SearchContext,
  searchType: SearchType,
): SearchQuery {
  const perPage = args.perPage ?? 20;
  const page = args.page ?? 1;
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
  if (where === undefined) {
    return [];
  }
  const filters: Filter[] = [];
  for (const field of filterableFields(searchType)) {
    const value = where[field.name];
    if (value === undefined || value === null) {
      continue;
    }
    switch (filterOperatorFor(field.kind)) {
      case 'in':
        filters.push({
          field: field.name,
          in: (value as { in?: string[] }).in ?? [],
        });
        break;
      case 'range': {
        const range = value as { min?: number | string; max?: number | string };
        filters.push({
          field: field.name,
          range: { min: range.min, max: range.max },
        });
        break;
      }
      default:
        filters.push({ field: field.name, is: value as boolean });
    }
  }
  return filters;
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
