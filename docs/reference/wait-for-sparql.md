# @lde/wait-for-sparql

Wait for a SPARQL endpoint to become available.

## Installation

```sh
npm install @lde/wait-for-sparql
```

## Usage

`waitForSparqlEndpointAvailable(url, options?)` polls the endpoint with a SPARQL query, retrying until the query succeeds and returns at least one result, and throws if the endpoint is still unavailable after the retries are exhausted:

```ts
import { waitForSparqlEndpointAvailable } from '@lde/wait-for-sparql';

await waitForSparqlEndpointAvailable('http://localhost:3000/sparql');
```

Options (exported as the `Options` interface):

| Option    | Type                    | Default                                  | Description                                                                                  |
| --------- | ----------------------- | ---------------------------------------- | -------------------------------------------------------------------------------------------- |
| `retries` | `number`                | `5`                                      | Number of retries before giving up.                                                          |
| `query`   | `string`                | `'construct where { ?s ?p ?o } limit 1'` | SPARQL query used to probe the endpoint.                                                     |
| `fetcher` | `SparqlEndpointFetcher` | `new SparqlEndpointFetcher()`            | Custom [fetch-sparql-endpoint](https://www.npmjs.com/package/fetch-sparql-endpoint) fetcher. |

Retrying uses [p-retry](https://www.npmjs.com/package/p-retry), so waits between attempts back off exponentially. Note that `retries` counts _retries_, not attempts: the default `retries: 5` makes up to 6 attempts in total.
