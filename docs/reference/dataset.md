# @lde/dataset

Classes for working with DCAT Datasets and Distributions.

## Installation

```sh
npm install @lde/dataset
```

## API

The package exports:

- `Dataset` – a DCAT dataset with `iri`, `title`, `description`, `language`, `license`, `creator`, `publisher` and its `distributions`. `getDownloadDistributions()` returns the downloadable (non-SPARQL) distributions, preferring compressed ones.
- `DatasetArguments` – the options object the `Dataset` constructor takes; only `iri` and `distributions` are required.
- `Creator` and `Publisher` – an agent’s `iri` plus its language-mapped `name`.
- `Distribution` – a DCAT distribution with `accessUrl`, `mediaType` (an IANA media type URI per DCAT-AP 3.0, or a plain content type for convenience), `mimeType`, `compressFormat`, `byteSize`, `lastModified` and more. The static `Distribution.sparql(endpoint, namedGraph?)` creates a SPARQL distribution.
  - `isSparql()` – `true` when the distribution’s `conformsTo` is the SPARQL 1.1 Protocol URI (`https://www.w3.org/TR/sparql11-protocol/`) or its `mimeType` is `application/sparql-query` or `application/sparql-results+json`.
  - `compressMimeType` – plain content type derived from `compressFormat` (e.g. `application/gzip`), or `undefined` when no compression format is declared.
  - `compressedMimeType` – the full content type a server is expected to send for the compressed download: `mimeType` with the compression suffix appended (e.g. `application/n-quads+gzip`), or `undefined` when no media type or no recognised compression format is declared.
  - `namedGraph` and `subjectFilter` – optional fields narrowing a SPARQL distribution: the named graph to query, and a SPARQL pattern fragment that pipeline queries splice in to restrict the subjects they select.
- `IANA_MEDIA_TYPE_PREFIX` – the `https://www.iana.org/assignments/media-types/` prefix that turns a plain content type into a DCAT-AP 3.0 media type URI.
- `RdfFormat` and `rdfFormatToFileExtension()` – RDF serialization formats and their file extensions.
- `rdfMediaTypes`, `sparqlMediaTypes` and `compressionMediaTypes` – media type constants for matching distributions. Note that `compressionMediaTypes` includes `application/octet-stream`: servers commonly label compressed bodies as opaque bytes, so consumers matching a declared RDF media type should ignore it like the gzip/zip types.
- `skolemIri()` and `hashSuffix()` – mint deterministic IRIs for otherwise-anonymous structural nodes, instead of blank nodes whose labels are not preserved across separately serialised documents.
- `assertSafeIri()` – throw if an IRI contains characters that could break out of a SPARQL `<…>` IRI reference.

Most exports carry JSDoc, so your editor shows inline documentation as you use them.
