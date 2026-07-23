# 14. Serve the search GraphQL API with graphql-yoga

Date: 2026-07-23

## Status

Accepted

Extends [ADR 4 (Search API GraphQL surface)](./0004-search-api-graphql-surface.md),
which deliberately stopped at `buildGraphQLSchema()` – an executable
`GraphQLSchema`, no transport. Implements the served layer of
[#600](https://github.com/ldelements/lde/issues/600).

## Context

Every consumer of `buildGraphQLSchema()` has to hand-roll the served endpoint:
a request handler calling `graphql()`, `Accept-Language` parsing, error
shaping – and gets no playground (`GET /graphql` is a blank page). The Dataset
Register did exactly that in a bespoke `+server.ts`. A public, read-only search
API also needs CORS for cross-origin browser clients and a guard against
arbitrarily expensive queries, which no consumer should have to reinvent.

The draft stack notes named Mercurius as the GraphQL server, but Mercurius is
Fastify-coupled while LDE consumers serve from many hosts – the Dataset
Register runs on SvelteKit (adapter-node), and future consumers may use Hono or
plain `node:http`.

## Decision

Ship a **framework-agnostic Web-`fetch` handler** in `@lde/search-api-graphql`:

```ts
createSearchGraphQLHandler({ searchSchema | schema, engine, … })
  → (request: Request) => Promise<Response>
```

built on **graphql-yoga** rather than Mercurius or hand-rolled plumbing – a
deliberate deviation from the draft stack. Yoga is `fetch`-native (every host
that speaks `Request`/`Response` mounts the handler in a few lines), serves any
executable schema, and brings introspection, error shaping and a plugin system.

- **Playground**: the self-contained GraphiQL that Yoga bundles
  (`@graphql-yoga/render-graphiql`) – no external CDN, so it is acceptable for
  a public service and `<iframe>`-embeddable in docs sites. The renderer is
  swappable (`renderPlayground`) and disable-able per environment
  (`playground: false`). Apollo Sandbox was rejected: its embed loads from
  Apollo’s CDN and ships schema and queries to Apollo.
- **Limits**: graphql-armor’s max-depth and cost-limit validation plugins guard
  the public endpoint; introspection is exempt so the playground keeps working.
- **Composability**: the handler takes either a `searchSchema` (it builds the
  GraphQL schema itself) or a ready `GraphQLSchema` – a consumer merges custom
  fields into `buildGraphQLSchema()`’s output and serves the union through the
  same endpoint and playground.
- **SDL**: `GET <endpoint>?sdl` returns `printSchema()` output, so consumers
  can publish the contract and generate static docs in CI without a running
  introspection query.
- **`Accept-Language`**: parsed (via `negotiator`, q-values respected) into the
  ordered list that `SearchContext.acceptLanguage` already expects.

## Consequences

- `@lde/search-api-graphql` now requires `graphql` ^16 (was ^15.8): the
  graphql-armor plugins do not accept 15, and a mixed tree fails at runtime
  with graphql-js’s realm check. Yoga supports 15 and 16, so 16 is the version
  both agree on. Breaking for consumers still pinned to graphql 15.
- The handler is the substrate for the prebuilt Docker image (#600 layer 3):
  the image is a boot entrypoint around this handler, not a separate codebase.
- The Dataset Register can retire its bespoke `+server.ts` and mount the
  handler (downstream follow-up).
- graphql-js prints SDL without a trailing newline from 16 on; the generator
  stability snapshot moved accordingly.
