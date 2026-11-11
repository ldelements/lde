import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import type { Literal, NamedNode, Quad } from '@rdfjs/types';
import PrefixMap from '@rdfjs/prefix-map/PrefixMap.js';
import TurtleSerializer from '@rdfjs/serializer-turtle';
import jsonld, { type Options } from 'jsonld';
import type { RemoteDocument } from 'jsonld/jsonld-spec.js';
import { DataFactory } from 'rdf-data-factory';

/**
 * Prefixes for common vocabularies, which every Turtle example may use.
 */
export const defaultTurtlePrefixes: ReadonlyMap<string, string> = new Map([
  ['dcat', 'http://www.w3.org/ns/dcat#'],
  ['dct', 'http://purl.org/dc/terms/'],
  ['foaf', 'http://xmlns.com/foaf/0.1/'],
  ['owl', 'http://www.w3.org/2002/07/owl#'],
  ['prov', 'http://www.w3.org/ns/prov#'],
  ['rdf', 'http://www.w3.org/1999/02/22-rdf-syntax-ns#'],
  ['rdfs', 'http://www.w3.org/2000/01/rdf-schema#'],
  ['schema', 'https://schema.org/'],
  ['sh', 'http://www.w3.org/ns/shacl#'],
  ['skos', 'http://www.w3.org/2004/02/skos/core#'],
  ['vcard', 'http://www.w3.org/2006/vcard/ns#'],
  ['xsd', 'http://www.w3.org/2001/XMLSchema#'],
]);

export interface TurtleOptions {
  /**
   * Local files to read JSON-LD contexts from instead of the web, keyed by the
   * context URL that a document cites. A trailing slash on either side is
   * ignored, so `https://schema.org` also matches `https://schema.org/`. A
   * relative file path is relative to the working directory.
   */
  contexts?: Record<string, string>;
  /** Prefixes the Turtle may use, by name. */
  prefixes?: ReadonlyMap<string, string>;
}

/**
 * Converts JSON-LD files to Turtle. Each converter reads the contexts the
 * files cite once, so a template can convert many files that share them.
 */
export class JsonLdToTurtle {
  private readonly contexts: Map<string, string>;
  private readonly prefixes: [string, string][];
  private readonly documents = new Map<string, Promise<RemoteDocument>>();

  constructor({
    contexts = {},
    prefixes = defaultTurtlePrefixes,
  }: TurtleOptions = {}) {
    this.contexts = new Map(
      Object.entries(contexts).map(([url, file]) => [
        withoutTrailingSlash(url),
        resolve(file),
      ]),
    );
    this.prefixes = [...prefixes];
  }

  /**
   * Prints a JSON-LD file as Turtle. Fails, rather than silently dropping
   * data, when the JSON-LD has a term without a mapping, a relative IRI or a
   * named graph.
   */
  async convert(path: string): Promise<string> {
    try {
      const quads = (await jsonld.toRDF(
        JSON.parse(await readFile(path, 'utf8')),
        {
          documentLoader: (url: string) => this.load(url),
          // Missing from @types/jsonld.
          safe: true,
        } as Options.ToRdf,
      )) as JsonLdQuad[];
      const rdfJsQuads = quads.map(toRdfJs);
      const serializer = new TurtleSerializer({
        prefixes: this.prefixesUsedBy(rdfJsQuads),
      });
      return serializer.transform(rdfJsQuads);
    } catch (error) {
      throw new Error(`Cannot convert ${path} to Turtle: ${reasonOf(error)}`, {
        cause: error,
      });
    }
  }

  // Only the prefixes that shorten every IRI in their namespace to a valid
  // local name, because the serializer shortens any IRI that starts with a
  // namespace, also to invalid Turtle such as ex:id/1. Terms the serializer
  // doesn’t write, yet declares a prefix for, don’t count: rdf:type, written
  // as `a`, and the datatypes of plain and language-tagged strings.
  private prefixesUsedBy(quads: Quad[]): PrefixMap {
    const iris = quads.flatMap((quad) =>
      [
        quad.subject,
        quad.predicate.equals(rdfType) ? undefined : quad.predicate,
        quad.object,
        quad.object.termType === 'Literal' &&
        !implicitDatatypes.has(quad.object.datatype.value)
          ? quad.object.datatype
          : undefined,
      ]
        .filter((term) => term?.termType === 'NamedNode')
        .map((term) => (term as NamedNode).value),
    );
    return new PrefixMap(
      this.prefixes
        .filter(([, namespace]) => {
          const localNames = iris
            .filter((iri) => iri.startsWith(namespace))
            .map((iri) => iri.slice(namespace.length));
          return (
            localNames.length > 0 &&
            localNames.every((localName) => localNamePattern.test(localName))
          );
        })
        .map(([prefix, namespace]) => [
          prefix,
          dataFactory.namedNode(namespace),
        ]),
      { factory: dataFactory },
    );
  }
  private load(url: string): Promise<RemoteDocument> {
    let document = this.documents.get(url);
    if (document === undefined) {
      const file = this.contexts.get(withoutTrailingSlash(url));
      document =
        file === undefined ? fetchDocument(url) : readDocument(url, file);
      // Keep a failure out of the cache, so the next file tries again.
      document.catch(() => this.documents.delete(url));
      this.documents.set(url, document);
    }
    return document;
  }
}

const dataFactory = new DataFactory();
const rdfType = dataFactory.namedNode(
  'http://www.w3.org/1999/02/22-rdf-syntax-ns#type',
);
const implicitDatatypes = new Set([
  'http://www.w3.org/1999/02/22-rdf-syntax-ns#langString',
  'http://www.w3.org/2001/XMLSchema#string',
]);
// A Turtle local name (PN_LOCAL) without escapes or colons, which the
// serializer doesn’t write.
const localNamePattern =
  /^(?:[\p{L}\p{N}_](?:[\p{L}\p{N}_.-]*[\p{L}\p{N}_-])?)?$/u;

async function readDocument(
  url: string,
  file: string,
): Promise<RemoteDocument> {
  return {
    documentUrl: url,
    document: JSON.parse(await readFile(file, 'utf8')),
  };
}

// Follows a Link header to an alternate JSON-LD document, as JSON-LD 1.1
// prescribes for a response that is not JSON, such as https://schema.org’s.
async function fetchDocument(url: string): Promise<RemoteDocument> {
  const response = await fetch(url, {
    headers: { accept: 'application/ld+json, application/json' },
  });
  if (!response.ok) {
    throw new Error(`${url} responded with HTTP status ${response.status}`);
  }
  const alternate = alternateJsonLd(response);
  if (alternate !== undefined) {
    return fetchDocument(new URL(alternate, response.url).href);
  }
  return {
    documentUrl: response.url,
    document: (await response.json()) as RemoteDocument['document'],
  };
}

function alternateJsonLd(response: Response) {
  if (/[/+]json\b/.test(response.headers.get('content-type') ?? '')) {
    return undefined;
  }
  for (const link of (response.headers.get('link') ?? '').split(',')) {
    const target = /<([^>]+)>/.exec(link)?.[1];
    if (
      target !== undefined &&
      /;\s*rel="?alternate"?/.test(link) &&
      /;\s*type="?application\/ld\+json"?/.test(link)
    ) {
      return target;
    }
  }
  return undefined;
}

// jsonld names what safe mode would drop, and why a context failed to load,
// only in the error’s details.
function reasonOf(error: unknown) {
  const { details } = error as {
    details?: { event?: { message: string; details: unknown }; cause?: Error };
  };
  if (details?.event !== undefined) {
    return `${details.event.message} ${JSON.stringify(details.event.details)}`;
  }
  const cause = details?.cause ?? error;
  return cause instanceof Error ? cause.message : String(cause);
}

function withoutTrailingSlash(url: string) {
  return url.replace(/\/$/, '');
}

// jsonld returns plain objects rather than RDF/JS terms.
interface JsonLdTerm {
  termType: string;
  value: string;
}
interface JsonLdLiteral extends JsonLdTerm {
  language?: string;
  datatype: JsonLdTerm;
}
interface JsonLdQuad {
  subject: JsonLdTerm;
  predicate: JsonLdTerm;
  object: JsonLdTerm | JsonLdLiteral;
  graph: JsonLdTerm;
}

function toRdfJs(quad: JsonLdQuad): Quad {
  if (quad.graph.termType !== 'DefaultGraph') {
    throw new Error(
      `named graphs, such as ${quad.graph.value}, are not supported`,
    );
  }
  return dataFactory.quad(
    toResource(quad.subject),
    dataFactory.namedNode(quad.predicate.value),
    quad.object.termType === 'Literal'
      ? toLiteral(quad.object as JsonLdLiteral)
      : toResource(quad.object),
  ) as Quad;
}

function toResource(term: JsonLdTerm) {
  return term.termType === 'BlankNode'
    ? dataFactory.blankNode(term.value.replace(/^_:/, ''))
    : dataFactory.namedNode(term.value);
}

function toLiteral({ value, language, datatype }: JsonLdLiteral): Literal {
  return dataFactory.literal(
    value,
    language || dataFactory.namedNode(datatype.value),
  );
}
