import { IANA_MEDIA_TYPE_PREFIX } from './distribution.js';

const iana = (type: string) => IANA_MEDIA_TYPE_PREFIX + type;

export const sparqlMediaTypes = [
  iana('application/sparql-query'),
  iana('application/sparql-results+json'),
  iana('application/sparql-results+xml'),
];

export const rdfMediaTypes = [
  iana('application/ld+json'),
  iana('application/n-quads'),
  iana('application/n-triples'),
  iana('application/rdf+xml'),
  iana('text/turtle'),
];

/**
 * Plain content types that indicate compression of the body rather than the
 * RDF serialization itself. Consumers use this to ignore an HTTP Content-Type
 * that just means "bytes were gzipped/zipped" when matching against a declared
 * RDF media type.
 */
export const compressionMediaTypes: ReadonlySet<string> = new Set([
  'application/gzip',
  'application/x-gzip',
  'application/zip',
  'application/octet-stream',
]);
