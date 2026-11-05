# @lde/local-sparql-endpoint

Start a local SPARQL endpoint that serves an RDF fixture file, for use in tests. The endpoint is a [Comunica SPARQL file server](https://github.com/comunica/comunica/tree/master/engines/query-sparql-file) started as a dev server on a port of your choosing.

## Installation

```sh
npm install @lde/local-sparql-endpoint
```

## Usage

The package exports two functions:

- `startSparqlEndpoint(port, fixture)` – start a SPARQL endpoint on `port`, serving the RDF file at `fixture`.
- `teardownSparqlEndpoint()` – stop the endpoint again.

In a Vitest test suite:

```ts
import {
  startSparqlEndpoint,
  teardownSparqlEndpoint,
} from '@lde/local-sparql-endpoint';

beforeAll(async () => {
  await startSparqlEndpoint(3002, 'test/fixtures/registry.ttl');
}, 60_000);

afterAll(async () => {
  await teardownSparqlEndpoint();
});
```

## Behaviour

- **One endpoint per process.** The server handle is module-level state: a second `startSparqlEndpoint()` call overwrites it, and `teardownSparqlEndpoint()` stops only the most recently started endpoint. Start at most one endpoint per test process.
- The Comunica server is started with `--distinctConstruct`, so `CONSTRUCT` results are deduplicated.
- Startup waits up to a built-in **60 second** launch timeout for the port to come up.
