# @lde/fastify-rdf

Fastify plugin for serving RDF data with automatic content negotiation.

## Installation

```sh
npm install @lde/fastify-rdf
```

```typescript
import fastify from 'fastify';
import fastifyRdf from '@lde/fastify-rdf';

const app = fastify();
await app.register(fastifyRdf);
```

## Documentation

See the [full documentation](https://ldelements.org/reference/fastify-rdf).
