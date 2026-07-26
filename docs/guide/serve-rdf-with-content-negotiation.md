# Serve RDF with content negotiation

This guide shows how to serve RDF from a [Fastify](https://fastify.dev) app in whatever serialisation the client asks for, using [@lde/fastify-rdf](../reference/fastify-rdf).

## Register the plugin

Install the plugin alongside Fastify:

```sh
npm install @lde/fastify-rdf
```

Then register it on your app:

```typescript
import fastify from 'fastify';
import fastifyRdf from '@lde/fastify-rdf';

const app = fastify();
await app.register(fastifyRdf);
```

## Serve RDF from a route

Return `reply.sendRdf()` with an RDF/JS dataset (such as an N3 `Store`) or quad stream. The plugin serialises it in the format the `Accept` header requests:

```typescript
import { DataFactory, Store } from 'n3';

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

Clients pick the format; without an `Accept` header (or with `*/*`) the response is Turtle:

```sh
curl -H "Accept: application/n-triples" http://localhost:3000/resource

curl http://localhost:3000/resource # Turtle
```

See the [@lde/fastify-rdf reference](../reference/fastify-rdf) for the supported formats and the remaining options: automatic serialisation of every response (`overrideSend`), parsing RDF request bodies (`parseRdf`), Hydra error responses (`reply.sendHydraError()`) and changing the default content type.
