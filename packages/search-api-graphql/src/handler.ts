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
 * directly.
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
   * arbitrary queries. Introspection is exempt. @default 15
   */
  readonly maxDepth?: number;
  /**
   * Reject queries costlier than this (graphql-armor cost limit; introspection
   * is exempt). @default 5000
   */
  readonly maxCost?: number;
  /** Forwarded to {@link SearchContext.onFacetError} on every request. */
  readonly onFacetError?: SearchContext['onFacetError'];
}

/**
 * The served search API: one `fetch` handler covering POST execution, the GET
 * playground, introspection, CORS, depth/cost limits, `Accept-Language`
 * parsing, and the SDL (`GET <endpoint>?sdl` – the schema contract without a
 * running introspection query).
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

  const yoga = createYoga({
    schema,
    graphqlEndpoint,
    landingPage: false,
    graphiql: options.playground !== false,
    renderGraphiQL: options.renderPlayground ?? renderGraphiQL,
    cors: options.cors,
    plugins: [
      maxDepthPlugin({ n: options.maxDepth ?? 15 }),
      costLimitPlugin({ maxCost: options.maxCost ?? 5000 }),
    ],
    context: ({ request }): SearchContext => ({
      engine: options.engine,
      acceptLanguage: parseAcceptLanguage(
        request.headers.get('accept-language'),
      ),
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
    return await yoga.fetch(request, {});
  };
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
