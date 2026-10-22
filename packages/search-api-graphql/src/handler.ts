import { printSchema, type GraphQLSchema } from 'graphql';
import {
  createYoga,
  type CORSOptions,
  type GraphiQLOptions,
} from 'graphql-yoga';
import { renderGraphiQL } from '@graphql-yoga/render-graphiql';
import { maxDepthPlugin } from '@escape.tech/graphql-armor-max-depth';
import { costLimitPlugin } from '@escape.tech/graphql-armor-cost-limit';
import Negotiator from 'negotiator';
import { maxSearchesPlugin } from './max-searches.js';
import type { SearchEngine, SearchSchema } from '@lde/search';
import {
  buildGraphQLSchema,
  type BuildGraphQLSchemaOptions,
  type SearchContext,
} from './build-schema.js';

/**
 * A framework-agnostic request handler: SvelteKit, Fastify (via a
 * `Request`/`Response` bridge), Hono and plain `node:http` (via
 * `@whatwg-node/server`, which graphql-yoga uses internally) all mount it
 * directly. On a runtime that has its own Fetch classes, the returned
 * `Response` is an instance of that runtime’s global, so a host that checks
 * `instanceof Response` accepts it as is.
 */
export type SearchGraphQLHandler = (request: Request) => Promise<Response>;

/**
 * Renders the playground page served on `GET` requests to the endpoint.
 * The default is the self-contained GraphiQL bundled with graphql-yoga
 * (no external CDN); supply your own to swap the renderer (e.g. Altair).
 */
export type PlaygroundRenderer = (
  options?: GraphiQLOptions,
) => BodyInit | Promise<BodyInit>;

export interface SearchGraphQLHandlerOptions {
  /**
   * The search schema to serve; the handler builds the GraphQL schema from it
   * with {@link buildGraphQLSchema}. Provide either this or {@link schema}.
   */
  readonly searchSchema?: SearchSchema;
  /**
   * A ready {@link GraphQLSchema} to serve instead – bring your own fields by
   * merging a custom schema with {@link buildGraphQLSchema}’s output (e.g.
   * `@graphql-tools/schema` `mergeSchemas`) and passing the union here.
   * Provide either this or {@link searchSchema}.
   */
  readonly schema?: GraphQLSchema;
  /** The engine every request’s resolvers search with. */
  readonly engine: SearchEngine;
  /** Options for {@link buildGraphQLSchema} when {@link searchSchema} is given. */
  readonly schemaOptions?: BuildGraphQLSchemaOptions;
  /** Endpoint path the handler serves. @default '/graphql' */
  readonly graphqlEndpoint?: string;
  /**
   * Serve the playground on `GET` requests to the endpoint. The page is
   * self-contained (no external CDN) and sends no framing headers, so a docs
   * site can `<iframe>` it as a live client. Disable per environment.
   * @default true
   */
  readonly playground?: boolean;
  /** Custom playground renderer; defaults to the bundled GraphiQL. */
  readonly renderPlayground?: PlaygroundRenderer;
  /**
   * CORS headers for cross-origin browser clients. Defaults to graphql-yoga’s
   * permissive default (reflects the request origin); pass `false` to send no
   * CORS headers.
   */
  readonly cors?: CORSOptions | boolean;
  /**
   * Reject queries nested deeper than this – a public playground invites
   * arbitrary queries. Introspection is exempt, and a fragment adds no level.
   * @default 15
   */
  readonly maxDepth?: number;
  /**
   * Reject queries costlier than this (graphql-armor cost limit; introspection
   * is exempt). Fragments are flattened: a nested fragment adds a fixed cost
   * (2 inline, 3 for a named spread) rather than multiplying its contents,
   * while a spread at the operation root costs its contents 1.5×, and a
   * repeated named fragment 1 plus 1.5× its first scoring. The cost does not
   * scale with `perPage` or count searches; {@link maxSearches} bounds those.
   * @default 5000
   */
  readonly maxCost?: number;
  /**
   * Reject operations that select more root fields than this. Each alias of a
   * search field runs its own search, which {@link maxCost} does not count;
   * with `maxPerPage`, this bounds the results those searches fetch. Every
   * root field counts, including a custom field merged in. Must be a positive
   * integer. @default 10
   */
  readonly maxSearches?: number;
  /** Forwarded to {@link SearchContext.onFacetError} on every request. */
  readonly onFacetError?: SearchContext['onFacetError'];
}

/**
 * The served search API: one `fetch` handler covering POST execution, the GET
 * playground, introspection, CORS, depth/cost limits, `Accept-Language`
 * parsing (answered with `Vary: Accept-Language` and a `Content-Language`
 * listing the displayed language of every localized value), and the SDL (`GET <endpoint>?sdl` – the
 * schema contract without a running introspection query).
 */
export function createSearchGraphQLHandler(
  options: SearchGraphQLHandlerOptions,
): SearchGraphQLHandler {
  if ((options.searchSchema === undefined) === (options.schema === undefined)) {
    throw new Error('Provide exactly one of searchSchema or schema.');
  }
  const schema =
    options.schema ??
    buildGraphQLSchema(options.searchSchema!, options.schemaOptions);
  const graphqlEndpoint = options.graphqlEndpoint ?? '/graphql';

  const yoga = createYoga<{ servedLanguages: Set<string> }>({
    schema,
    graphqlEndpoint,
    // Build responses with the runtime’s own Fetch classes, so the handler’s
    // `Response` is the class a host framework checks against. graphql-yoga
    // otherwise uses `@whatwg-node/fetch`, a ponyfill: spec-conformant, but a
    // different class, which every host that checks `instanceof Response`
    // nominally – SvelteKit, Hono, Next – rejects. yoga ignores the keys a
    // runtime leaves `undefined`, so one without them keeps the ponyfill.
    fetchAPI: {
      Request: globalThis.Request,
      Response: globalThis.Response,
      ReadableStream: globalThis.ReadableStream,
    },
    landingPage: false,
    graphiql: options.playground !== false,
    renderGraphiQL: options.renderPlayground ?? renderGraphiQL,
    cors: options.cors,
    plugins: [
      // Flatten fragments so a fragment spread doesn’t count as an extra level,
      // which multiplies the cost per fragment. A small cost per spread remains.
      maxDepthPlugin({ n: options.maxDepth ?? 15, flattenFragments: true }),
      costLimitPlugin({
        maxCost: options.maxCost ?? 5000,
        flattenFragments: true,
      }),
      maxSearchesPlugin(options.maxSearches ?? 10),
    ],
    context: ({ request, servedLanguages }): SearchContext => ({
      engine: options.engine,
      acceptLanguage: parseAcceptLanguage(
        request.headers.get('accept-language'),
      ),
      servedLanguages,
      onFacetError: options.onFacetError,
    }),
  });
  const sdl = printSchema(schema);

  return async (request: Request): Promise<Response> => {
    const url = new URL(request.url);
    if (
      request.method === 'GET' &&
      url.pathname === graphqlEndpoint &&
      url.searchParams.has('sdl')
    ) {
      return new Response(sdl, {
        headers: { 'content-type': 'application/graphql; charset=utf-8' },
      });
    }
    const servedLanguages = new Set<string>();
    const response = await yoga.fetch(request, { servedLanguages });
    // Results differ per Accept-Language (output order, search and sort
    // locale), so a shared cache must key on it.
    response.headers.append('vary', 'Accept-Language');
    const contentLanguage = toContentLanguage(servedLanguages);
    if (contentLanguage !== undefined) {
      response.headers.set('content-language', contentLanguage);
    }
    return response;
  };
}

/**
 * A `Content-Language` value for the served languages: tags come from indexed
 * data, so drop any that is not a well-formed language tag (it could make an
 * invalid header) and fold case-only duplicates. Tags keep the spelling the
 * body serves them in, so the header names the same languages as
 * `LanguageString.language`.
 */
function toContentLanguage(
  servedLanguages: ReadonlySet<string>,
): string | undefined {
  const tagsByLowerCase = new Map<string, string>();
  for (const language of servedLanguages) {
    const lowerCase = language.toLowerCase();
    if (!tagsByLowerCase.has(lowerCase) && isLanguageTag(language)) {
      tagsByLowerCase.set(lowerCase, language);
    }
  }
  return tagsByLowerCase.size > 0
    ? [...tagsByLowerCase.values()].join(', ')
    : undefined;
}

/**
 * Whether a string is a well-formed Unicode BCP 47 locale identifier – the
 * subset of BCP 47 that `Intl` accepts, which excludes private-use (`x-…`)
 * and grandfathered (`i-klingon`) tags.
 */
function isLanguageTag(language: string): boolean {
  try {
    Intl.getCanonicalLocales(language);
    return true;
  } catch {
    return false;
  }
}

/** Ordered languages from an `Accept-Language` header (best first, by q-value). */
function parseAcceptLanguage(header: string | null): readonly string[] {
  if (header === null) {
    return [];
  }
  const negotiator = new Negotiator({
    headers: { 'accept-language': header },
  });
  return negotiator.languages().filter((language) => language !== '*');
}
