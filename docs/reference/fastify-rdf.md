# @lde/fastify-rdf

Fastify plugin for serving RDF data with automatic content negotiation.

## Installation

```bash
npm install @lde/fastify-rdf
```

## Features

- Content negotiation for all RDF serialisation formats supported by [rdf-serialize](https://github.com/rubensworks/rdf-serialize.js)
- Handles `Accept` headers to serve data in the requested RDF format (Turtle, N-Triples, JSON-LD, etc.)
- Defaults to Turtle when no `Accept` header is provided
- Provides a `reply.sendRdf()` decorator for explicit RDF responses
- Optional `overrideSend` mode to automatically serialise all responses as RDF

## Usage

### Basic Setup

```typescript
import fastify from 'fastify';
import fastifyRdf from '@lde/fastify-rdf';

const app = fastify();
await app.register(fastifyRdf);
```

### Explicit RDF Responses with `reply.sendRdf()`

Use `reply.sendRdf()` to send RDF data with content negotiation:

```typescript
import { Store, DataFactory } from 'n3';

const { namedNode, literal, quad } = DataFactory;

app.get('/resource', async (request, reply) => {
  const store = new Store();
  store.add(
    quad(
      namedNode('http://example.org/subject'),
      namedNode('http://example.org/predicate'),
      literal('object'),
    ),
  );
  return reply.sendRdf(store);
});
```

### Automatic Serialisation with `overrideSend`

Enable `overrideSend` to automatically serialise all responses as RDF. This is useful for APIs that exclusively serve RDF data:

```typescript
await app.register(fastifyRdf, {
  overrideSend: true,
});

// Simply return DatasetCore or Stream - they will be serialised automatically
app.get('/resource', async () => {
  const store = new Store();
  store.add(
    quad(
      namedNode('http://example.org/subject'),
      namedNode('http://example.org/predicate'),
      literal('object'),
    ),
  );
  return store;
});
```

`overrideSend` is implemented with `preSerialization` and `onSend` hooks that treat **every** non-string payload as RDF – including error payloads, so make sure custom error handlers produce RDF (e.g. via `reply.sendHydraError()`) or strings.

### Parsing RDF Request Bodies

The plugin registers content type parsers for all RDF formats supported by [rdf-parse](https://github.com/rubensworks/rdf-parse.js). Individual routes opt in via `config: { parseRdf: true }` – the body is then parsed into a `DatasetCore`:

```typescript
app.post('/data', { config: { parseRdf: true } }, async (request) => {
  const dataset = request.body as DatasetCore; // N3 Store
  console.log(`Received ${dataset.size} quads`);
});
```

To parse RDF bodies on **all** routes, enable `parseRdf` at the plugin level:

```typescript
await app.register(fastifyRdf, { parseRdf: true });
```

Routes without per-route or plugin-level `parseRdf` get JSON fallback for `application/ld+json` (parsed as plain JSON) and 415 Unsupported Media Type for other RDF content types.

#### Request body errors

| Request body                                                | Response                                                |
| ----------------------------------------------------------- | ------------------------------------------------------- |
| Malformed JSON in an `application/ld+json` body             | 400, from the JSON parser                               |
| Body that fails to parse as RDF, on a `parseRdf` route      | 400 `Invalid RDF body` (the parse error as its `cause`) |
| Non-JSON-LD RDF content type, on a route without `parseRdf` | 415 Unsupported Media Type                              |

### Hydra Error Responses with `reply.sendHydraError()`

Send [Hydra](https://www.hydra-cg.com/spec/latest/core/) error responses with content negotiation. This maps `error.message` to `hydra:title` and `error.cause` (when it is a string) to `hydra:description`:

```typescript
app.get('/resource', async (request, reply) => {
  const error = new Error('Not Found', {
    cause: 'The requested dataset was not found',
  }) as Error & { statusCode: number };
  error.statusCode = 404;
  return reply.sendHydraError(error);
});
```

The status code is taken from `error.statusCode` (standard in Fastify and http-errors), defaulting to 500.

For `Accept: application/ld+json`, the response is compact JSON-LD – no `jsonld` dependency needed:

```json
{
  "@context": "http://www.w3.org/ns/hydra/core#",
  "@type": "Error",
  "title": "Not Found",
  "description": "The requested dataset was not found"
}
```

For all other RDF formats (Turtle, N-Triples, etc.), the error is serialised through the standard RDF pipeline.

### Custom Default Content Type

By default, the plugin uses `text/turtle` when no `Accept` header is provided. You can change this:

```typescript
await app.register(fastifyRdf, {
  defaultContentType: 'application/n-triples',
});
```

## Content Negotiation

The plugin supports all content types provided by [rdf-serialize](https://github.com/rubensworks/rdf-serialize.js), including:

- `text/turtle` (Turtle)
- `application/n-triples` (N-Triples)
- `application/n-quads` (N-Quads)
- `application/ld+json` (JSON-LD)
- `application/rdf+xml` (RDF/XML)
- And more...

Clients can request their preferred format via the `Accept` header:

```bash
# Request Turtle
curl -H "Accept: text/turtle" http://localhost:3000/resource

# Request N-Triples
curl -H "Accept: application/n-triples" http://localhost:3000/resource

# No Accept header - defaults to Turtle
curl http://localhost:3000/resource
```

An `Accept` header that matches none of the supported types falls back to `defaultContentType` – the plugin never responds with 406 Not Acceptable.

SHACL Compact Syntax (`text/shaclc*`) output types are excluded from negotiation: serialising them requires a base IRI the plugin cannot provide generically.

## API

### Plugin Options

```typescript
interface FastifyRdfOptions {
  /**
   * Default content type when no Accept header is provided.
   * @default 'text/turtle'
   */
  defaultContentType?: string;

  /**
   * Override reply.send() to serialise all responses as RDF.
   * When enabled, all payloads returned from route handlers will be
   * serialised as RDF without type checking.
   * @default false
   */
  overrideSend?: boolean;

  /**
   * Parse RDF request bodies into a DatasetCore on all routes.
   * @default false
   */
  parseRdf?: boolean;
}
```

### Supported Data Types

The plugin accepts the following RDF data types:

- **DatasetCore**: RDF.js dataset (e.g., from n3 `Store`)
- **Stream**: RDF.js quad stream (e.g., from parsers)

```typescript
import type { RdfData, FastifyRdfOptions } from '@lde/fastify-rdf';
```

### Other exports

- `createHydraErrorDataset(title, description?)` – build the N3 `Store` holding a Hydra error’s triples (`hydra:Error` with `hydra:title` and optional `hydra:description`), for use outside `reply.sendHydraError()`.
- `DEFAULT_CONTENT_TYPE` – the built-in default content type, `'text/turtle'`.

## TypeScript

The plugin includes full TypeScript support with type augmentation for Fastify's reply object:

```typescript
// reply.sendRdf() is automatically typed
app.get('/data', async (request, reply) => {
  return reply.sendRdf(dataset);
});
```
