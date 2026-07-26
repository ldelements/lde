# Test a pipeline against a local endpoint

This guide shows how to run pipeline code in tests against a throwaway local SPARQL endpoint that serves an RDF fixture file – no external triplestore required.

## Start an endpoint around the test suite

Install the endpoint package as a dev dependency:

```sh
npm install --save-dev @lde/local-sparql-endpoint
```

Then start it in `beforeAll` and tear it down in `afterAll`:

```typescript
import {
  startSparqlEndpoint,
  teardownSparqlEndpoint,
} from '@lde/local-sparql-endpoint';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

describe('SparqlConstructReader', () => {
  const port = 3003;

  beforeAll(async () => {
    await startSparqlEndpoint(port, 'test/fixtures/analysisTarget.trig');
  }, 60_000);

  afterAll(async () => {
    await teardownSparqlEndpoint();
  });

  // Tests query http://localhost:3003/sparql …
});
```

`startSparqlEndpoint(port, fixture)` boots a [Comunica SPARQL file server](https://github.com/comunica/comunica/tree/master/engines/query-sparql-file) that serves the fixture at `http://localhost:<port>/sparql`. The fixture is any RDF file – use TriG when your test needs named graphs. Give `beforeAll` a generous timeout (`60_000` above): the first start may need to fetch the server binary. See the [@lde/local-sparql-endpoint reference](../reference/local-sparql-endpoint) for details.

## Give each suite a unique port

Test runners execute suites in parallel, so two suites that start an endpoint on the same port collide. This repository’s convention: every test file that starts a local SPARQL endpoint claims its own port, tracked in a single list (in `CLAUDE.md`) so new suites pick a free one.

## Wait for an endpoint you start yourself

`startSparqlEndpoint` already blocks until the server listens. When your test boots an endpoint some other way – a Docker container, a [QLever server](../reference/sparql-qlever) – poll it with [@lde/wait-for-sparql](../reference/wait-for-sparql) before querying:

```typescript
import { waitForSparqlEndpointAvailable } from '@lde/wait-for-sparql';

await waitForSparqlEndpointAvailable('http://localhost:7001/sparql');
```

It retries until a probe query returns at least one result, so it also confirms the fixture data is actually loaded.
