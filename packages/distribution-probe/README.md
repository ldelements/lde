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

#### Reachability (the default)

Sends `HEAD` with `Accept: <distribution.mimeType>` and `Accept-Encoding: identity`. A successful `HEAD` settles reachability and gathers metadata (`Content-Length`, `Last-Modified`) **without reading the body**. If `HEAD` is unsuccessful — e.g. a server that returns `405`/`501` because it does not implement `HEAD` — the probe falls back to a body-less `GET` to confirm the endpoint is up. The body is never downloaded.

This is deliberately cheap: reading a body forces a slow, generate-on-the-fly endpoint (a TriplyDB dump, a SPARQL `CONSTRUCT` export) to start producing its export, which a `HEAD` does not.

- **Content-Type is checked as a soft warning, not a hard failure.** If the server’s Content-Type disagrees with the distribution’s declared `mimeType`, a message is appended to `result.warnings` but `isSuccess()` stays `true`. Compression wrappers (`application/gzip`, `application/x-gzip`, `application/octet-stream`) are skipped so a gzipped Turtle file doesn’t trigger a warning.

#### Content validation (opt-in)

Set `validateRdfContent: true` to additionally confirm that a dump actually carries RDF. It applies only to distributions whose **declared** `mimeType` is an RDF serialization (`text/turtle`, `application/n-triples`, `application/n-quads`, `application/trig`, `text/n3`, `application/ld+json`, `application/rdf+xml`); non-RDF and undeclared-type distributions stay reachability-only.

When on, the probe `GET`s the dump — **regardless of size** — and reads only a **bounded prefix** (256 KiB), never the whole body:

- It settles on the **first triple** and stops, so a large dump is validated from its opening chunk. The line/statement-oriented serializations and RDF/XML stream a triple out of the prefix; **JSON-LD is not streamable** (its parser needs the whole document), so a JSON-LD dump is only validated when it fits the prefix in full — a larger one is reported reachable but unvalidated.
- A gzip body that `fetch` did not decompress (a `.gz` dump, or one served with a non-standard `Content-Encoding`) is inflated in-place; a gzip that will not inflate when the **complete** compressed body was read fails as `Distribution is not valid gzip`.
- Empty bodies (`Distribution is empty`) and bodies that parse to **zero** triples (`Distribution contains no RDF triples`) fail the probe. A deliberately truncated prefix is never mistaken for either — it is inconclusive.
- **Reachability is settled by the response, so validation never turns a reachable dump into a failure.** If no triple surfaces within `rdfValidationBudgetMs` (default `min(timeoutMs, 2000)`, clamped to `timeoutMs`), the read is aborted and the distribution is reported reachable but unvalidated (no `failureReason`). This bounds the extra latency content validation adds on slow, generate-on-the-fly endpoints.

### Network errors

A thrown exception from `fetch` (DNS failure, connection refused, socket reset, TLS error, timeout after the configured `timeoutMs` – default 5 000 ms) is a connection-level failure. The probe retries these up to `retries` times (default 2) with a short backoff before giving up and returning a `NetworkError`. This turns a transient transport blip into a reliable single measurement without looking backward across checks. A genuine outage still resolves to a `NetworkError` on the current check – every attempt fails – but note each attempt gets its own `timeoutMs`, so an endpoint that fails only by timing out takes up to `(retries + 1) × timeoutMs` (plus backoff) to be reported down. HTTP error responses (4xx/5xx) and content-validation failures are real ‘down’ states and are **never** retried.

`NetworkError.message` includes the underlying `error.cause` (e.g. `ECONNRESET`, `UND_ERR_SOCKET “other side closed”`) when Node wraps one, so observations record what actually failed rather than a bare ‘fetch failed’.
