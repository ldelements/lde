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
  outputFields,
  sortableFields,
  type Filter,
  type LocalizedValue,
  type Reference,
  type SearchEngine,
  type SearchField,
  type SearchQuery,
  type SearchSchema,
  type Sort,
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
}

export interface BuildSearchSchemaOptions {
  /** Drives all derived type names, e.g. `Dataset`. */
  readonly typeName: string;
  /** Root query field; defaults to the lowercased plural of `typeName`. */
  readonly queryField?: string;
  /** Consumer policy applied to every query (default status, sort, tie-breaks). */
  readonly queryDefaults?: (
    query: SearchQuery,
    context: SearchContext,
  ) => SearchQuery;
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
 * Construct an executable GraphQL schema from the unified {@link SearchField}
 * model at runtime — no codegen, no SDL artifact. One generic resolver maps the
 * arguments to a {@link SearchQuery}, calls `context.engine`, and maps the result
 * back; the field model only parameterises data.
 */
export function buildSearchSchema(
  schema: SearchSchema,
  options: BuildSearchSchemaOptions,
): GraphQLSchema {
  const { typeName } = options;
  const languageOrder = options.languageOrder ?? defaultLanguageOrder;
  const queryField =
    options.queryField ??
    `${typeName.charAt(0).toLowerCase()}${typeName.slice(1)}s`;

  // --- Shared types ---
  const languageString = new GraphQLObjectType({
    name: 'LanguageString',
    fields: {
      language: { type: GraphQLString },
      value: { type: new GraphQLNonNull(GraphQLString) },
    },
  });
  const facetBucket = new GraphQLObjectType({
    name: 'FacetBucket',
    fields: {
      value: { type: new GraphQLNonNull(GraphQLString) },
      count: { type: new GraphQLNonNull(GraphQLInt) },
      // Nullable: the resolved data label for a reference facet, else null —
      // the consumer owns display for token/free-string facets (its i18n or the
      // value itself).
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

  // --- Reference types, one per referenced shape, reused by every field. ---
  const referenceTypes = new Map<string, GraphQLObjectType>();
  for (const field of outputFields(schema)) {
    if (
      field.kind === 'reference' &&
      field.ref &&
      !referenceTypes.has(field.ref.type)
    ) {
      referenceTypes.set(
        field.ref.type,
        new GraphQLObjectType({
          name: field.ref.type,
          fields: {
            id: {
              type: new GraphQLNonNull(GraphQLString),
              resolve: (source: Source) => (source as unknown as Reference).id,
            },
            name: labelList((source) => (source as unknown as Reference).label),
          },
        }),
      );
    }
  }

  // --- Output type ---
  const outputType = new GraphQLObjectType({
    name: typeName,
    fields: () => {
      const fields: Record<
        string,
        GraphQLFieldConfig<Source, SearchContext>
      > = {
        id: { type: new GraphQLNonNull(GraphQLString) },
      };
      for (const field of outputFields(schema)) {
        fields[field.name] = outputFieldConfig(field);
      }
      return fields;
    },
  });

  function outputFieldConfig(
    field: SearchField,
  ): GraphQLFieldConfig<Source, SearchContext> {
    const passthrough = (source: Source) => source[field.name] ?? null;
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
          : { type: scalarOutput(GraphQLString, field), resolve: passthrough };
      case 'reference': {
        const referenceType = referenceTypes.get(field.ref?.type ?? '')!;
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
              resolve: passthrough,
            };
      }
      case 'integer':
        return { type: scalarOutput(GraphQLInt, field), resolve: passthrough };
      case 'number':
        return {
          type: scalarOutput(GraphQLFloat, field),
          resolve: passthrough,
        };
      case 'date':
        // Stored as Unix seconds (int64); the surface serves ISO 8601 (ADR 4).
        return {
          type: scalarOutput(GraphQLString, field),
          resolve: (source) => {
            const value = source[field.name];
            return typeof value === 'number'
              ? new Date(value * 1000).toISOString()
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

  // --- where / orderBy / facets ---
  const whereInput = new GraphQLInputObjectType({
    name: `${typeName}Where`,
    fields: () => {
      const fields: Record<string, GraphQLInputFieldConfig> = {};
      for (const field of filterableFields(schema)) {
        fields[field.name] = { type: whereFieldType(field) };
      }
      return fields;
    },
  });

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

  const sortValues: GraphQLEnumValueConfigMap = {
    RELEVANCE: { value: 'relevance' },
  };
  for (const field of sortableFields(schema)) {
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

  const facetValues: GraphQLEnumValueConfigMap = {};
  for (const field of facetableFields(schema)) {
    facetValues[screamingSnake(field.name)] = { value: field.name };
  }
  const facetField = new GraphQLEnumType({
    name: `${typeName}FacetField`,
    values: facetValues,
  });
  const facet = new GraphQLObjectType({
    name: 'Facet',
    fields: {
      field: { type: new GraphQLNonNull(facetField) },
      buckets: { type: nonNullListOf(facetBucket) },
    },
  });

  const resultType = new GraphQLObjectType({
    name: `${typeName}SearchResult`,
    fields: {
      items: { type: nonNullListOf(outputType) },
      total: { type: new GraphQLNonNull(GraphQLInt) },
      page: { type: new GraphQLNonNull(GraphQLInt) },
      perPage: { type: new GraphQLNonNull(GraphQLInt) },
      facets: { type: nonNullListOf(facet) },
    },
  });

  const query = new GraphQLObjectType({
    name: 'Query',
    fields: {
      [queryField]: {
        type: new GraphQLNonNull(resultType),
        args: {
          query: { type: GraphQLString },
          where: { type: whereInput },
          orderBy: { type: orderByInput },
          page: { type: GraphQLInt, defaultValue: 1 },
          perPage: { type: GraphQLInt, defaultValue: 20 },
          facets: { type: new GraphQLList(new GraphQLNonNull(facetField)) },
        },
        resolve: async (_source, args, context: SearchContext) => {
          const built = argsToQuery(args as QueryArgs, context, schema);
          const finalQuery = options.queryDefaults
            ? options.queryDefaults(built, context)
            : built;
          const result = await context.engine.search(finalQuery, schema);
          return {
            items: result.hits.map((hit) => ({ id: hit.id, ...hit.document })),
            total: result.total,
            page: Math.floor(finalQuery.offset / finalQuery.limit) + 1,
            perPage: finalQuery.limit,
            facets: Object.entries(result.facets).map(([field, buckets]) => ({
              field,
              buckets,
            })),
          };
        },
      },
    },
  });

  return new GraphQLSchema({ query });
}

/**
 * The SDL of the built schema. Not a shipped artifact — a consumer uses it for an
 * optional CI snapshot test over its own schema, catching accidental breaking
 * changes to its frozen contract (including a `buildSearchSchema` change in a
 * future version of this library silently altering it).
 */
export function printSearchSchema(
  schema: SearchSchema,
  options: BuildSearchSchemaOptions,
): string {
  return printSchema(buildSearchSchema(schema, options));
}

interface QueryArgs {
  readonly query?: string;
  readonly where?: Record<string, unknown>;
  readonly orderBy?: { field: string; direction: 'asc' | 'desc' };
  readonly page?: number;
  readonly perPage?: number;
  readonly facets?: readonly string[];
}

/** Pure args → {@link SearchQuery} mapping. */
function argsToQuery(
  args: QueryArgs,
  context: SearchContext,
  schema: SearchSchema,
): SearchQuery {
  const perPage = args.perPage ?? 20;
  const page = args.page ?? 1;
  return {
    text: args.query,
    where: whereToFilters(args.where, schema),
    orderBy: args.orderBy
      ? [{ field: args.orderBy.field, direction: args.orderBy.direction }]
      : [],
    limit: perPage,
    offset: (page - 1) * perPage,
    facets: args.facets ?? [],
    locale: context.acceptLanguage[0] ?? 'und',
  };
}

function whereToFilters(
  where: Record<string, unknown> | undefined,
  schema: SearchSchema,
): Filter[] {
  if (where === undefined) {
    return [];
  }
  const filters: Filter[] = [];
  for (const field of filterableFields(schema)) {
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

// Re-exported for callers that compose a sort manually.
export type { Sort };
