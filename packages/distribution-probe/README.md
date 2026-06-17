# Distribution Probe

Probes a DCAT `Distribution` to check availability and gather metadata. Returns `SparqlProbeResult`, `DataDumpProbeResult`, or `NetworkError` – the probe never throws.

```ts
import { Distribution } from '@lde/dataset';
import { probe } from '@lde/distribution-probe';

const distribution = new Distribution(
  new URL('https://example.org/data.ttl'),
  'text/turtle',
);
const result = await probe(distribution);
```

## Behaviour

### SPARQL endpoints

Sends `POST` with `SELECT * { ?s ?p ?o } LIMIT 1` and `Accept: application/sparql-results+json`, then:

- **Content-Type is enforced.** The response Content-Type must start with `application/sparql-results+json`; anything else fails the probe (`isSuccess() === false`). This rules out HTML error pages served with `200 OK`.
- The JSON body must parse and contain a `results` object. Empty bodies, invalid JSON, and missing `results` all fail the probe with a `failureReason`.

### Data dumps

Sends `HEAD` with `Accept: <distribution.mimeType>` and `Accept-Encoding: identity`. If `Content-Length` is missing or ≤ 10 KB, retries with `GET` to validate the body – this also catches servers that return `0` from `HEAD`.

- **Content-Type is checked as a soft warning, not a hard failure.** If the server’s Content-Type disagrees with the distribution’s declared `mimeType`, a message is appended to `result.warnings` but `isSuccess()` stays `true`. Compression wrappers (`application/gzip`, `application/x-gzip`, `application/octet-stream`) are skipped so a gzipped Turtle file doesn’t trigger a warning.
- **Body is parse-validated only for Turtle, N-Triples, and N-Quads** (Content-Type starting with `text/turtle`, `application/n-triples`, or `application/n-quads`). Empty bodies and parse errors fail the probe. Other RDF serializations (RDF/XML, JSON-LD, TriG, …) are not parse-validated – only HTTP status and headers are checked.
- Bodies larger than 10 KB are not fetched; only `HEAD` metadata is inspected.

### Network errors

A thrown exception from `fetch` (DNS failure, connection refused, socket reset, TLS error, timeout after the configured `timeoutMs` – default 5 000 ms) is a connection-level failure. The probe retries these up to `retries` times (default 2) with a short backoff before giving up and returning a `NetworkError`. This turns a transient transport blip into a reliable single measurement without looking backward across checks; a genuine outage still reports immediately, since every attempt fails. HTTP error responses (4xx/5xx) and content-validation failures are real ‘down’ states and are **never** retried.

`NetworkError.message` includes the underlying `error.cause` (e.g. `ECONNRESET`, `UND_ERR_SOCKET “other side closed”`) when Node wraps one, so observations record what actually failed rather than a bare ‘fetch failed’.
