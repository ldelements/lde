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

Sends `POST` with the configured query (default `SELECT * { ?s ?p ?o } LIMIT 1`). The query type is detected (`ASK` / `SELECT` / `CONSTRUCT` / `DESCRIBE`) and drives both the `Accept` header and how the response is validated:

- **`ASK` / `SELECT`** request `application/sparql-results+json`, with `application/sparql-results+xml` as a lower-priority fallback. The response Content-Type must be one of those — anything else fails the probe (`isSuccess() === false`), which rules out HTML error pages served with `200 OK`. The body must parse and contain a results document (a `results` object for `SELECT`, a `boolean` for `ASK`); empty bodies, invalid JSON/XML, and missing results all fail with a `failureReason`.
- **`CONSTRUCT` / `DESCRIBE`** request the common RDF serializations (`text/turtle`, `application/n-triples`, `application/rdf+xml`, `application/ld+json`, `application/n-quads`, `application/trig`) and accept any of them. A `2xx` RDF response confirms availability, and **an empty graph is a valid answer** — so an empty body does not fail the probe (unlike a data dump, which must be non-empty). The body is not parse-validated.

### Data dumps

Sends `HEAD` with `Accept: <distribution.mimeType>` and `Accept-Encoding: identity`. If `Content-Length` is missing or ≤ 10 KB, retries with `GET` to validate the body – this also catches servers that return `0` from `HEAD`.

- **Content-Type is checked as a soft warning, not a hard failure.** If the server’s Content-Type disagrees with the distribution’s declared `mimeType`, a message is appended to `result.warnings` but `isSuccess()` stays `true`. Compression wrappers (`application/gzip`, `application/x-gzip`, `application/octet-stream`) are skipped so a gzipped Turtle file doesn’t trigger a warning.
- **Body is parse-validated only for Turtle, N-Triples, and N-Quads** (Content-Type starting with `text/turtle`, `application/n-triples`, or `application/n-quads`). Empty bodies and parse errors fail the probe. Other RDF serializations (RDF/XML, JSON-LD, TriG, …) are not parse-validated – only HTTP status and headers are checked.
- Bodies larger than 10 KB are not fetched; only `HEAD` metadata is inspected.

### Network errors

A thrown exception from `fetch` (DNS failure, connection refused, socket reset, TLS error, timeout after the configured `timeoutMs` – default 5 000 ms) is a connection-level failure. The probe retries these up to `retries` times (default 2) with a short backoff before giving up and returning a `NetworkError`. This turns a transient transport blip into a reliable single measurement without looking backward across checks. A genuine outage still resolves to a `NetworkError` on the current check – every attempt fails – but note each attempt gets its own `timeoutMs`, so an endpoint that fails only by timing out takes up to `(retries + 1) × timeoutMs` (plus backoff) to be reported down. HTTP error responses (4xx/5xx) and content-validation failures are real ‘down’ states and are **never** retried.

`NetworkError.message` includes the underlying `error.cause` (e.g. `ECONNRESET`, `UND_ERR_SOCKET “other side closed”`) when Node wraps one, so observations record what actually failed rather than a bare ‘fetch failed’.
