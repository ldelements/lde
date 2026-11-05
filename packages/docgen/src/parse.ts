import { Readable } from 'node:stream';
import type { Quad, Term } from '@rdfjs/types';
import { rdfDereferencer } from 'rdf-dereference';
import { DataFactory } from 'rdf-data-factory';
import { JsonLdArray } from 'jsonld/jsonld-spec.js';
import jsonld from 'jsonld';
import { rdfSerializer } from 'rdf-serialize';
import streamToString from 'stream-to-string';
import { xsd } from '@tpluscode/rdf-ns-builders';

export async function parseRdfToJsonLd(filePath: string): Promise<JsonLdArray> {
  const { data } = await rdfDereferencer.dereference(filePath, {
    localFiles: true,
  });

  const quads: Quad[] = [];
  for await (const quad of data) {
    quads.push(quad);
  }

  // Convert to n-quads, the only input format that the jsonld library takes.
  const nq = rdfSerializer.serialize(Readable.from(relabelBlankNodes(quads)), {
    contentType: 'application/n-quads',
  });

  const nqString = await streamToString(nq);

  const expanded = await jsonld.fromRDF(nqString, {
    useNativeTypes: true, // Convert xsd:integer to Number etc.
  });

  // jsonld v9 emits @type: xsd:string on every plain string literal; v8 omitted
  // it because xsd:string is the JSON-LD default datatype. Without this strip,
  // framing yields { @value, @type } objects that templates render as
  // ‘[object Object]’. See https://github.com/ldelements/lde/issues/369.
  return stripDefaultStringType(expanded);
}

const dataFactory = new DataFactory();

/**
 * jsonld orders nodes by their blank node labels as strings, which loses the
 * order of the source file: the parser’s labels sort alphabetically, and
 * numbered ones put `b10` before `b2`. Relabel blank nodes in the order the
 * parser first emits them as a subject, zero-padded to one width, so that
 * shapes, and the sections a template renders from them, keep the order in
 * which the source file defines them. A shape referenced before its
 * definition, such as one named in an `sh:node`, still sorts where it is
 * defined.
 */
function relabelBlankNodes(quads: Quad[]): Quad[] {
  const labels = new Map<string, string>();
  const terms = [
    ...quads.map((quad) => quad.subject),
    ...quads.flatMap((quad) => [quad.object, quad.graph]),
  ];
  for (const term of terms) {
    if (term.termType === 'BlankNode' && !labels.has(term.value)) {
      labels.set(term.value, '');
    }
  }
  const width = String(labels.size).length;
  [...labels.keys()].forEach((label, index) =>
    labels.set(label, `b${String(index).padStart(width, '0')}`),
  );

  const relabel = <T extends Term>(term: T): T =>
    (term.termType === 'BlankNode'
      ? dataFactory.blankNode(labels.get(term.value))
      : term) as T;

  return quads.map((quad) =>
    dataFactory.quad(
      relabel(quad.subject),
      quad.predicate,
      relabel(quad.object),
      relabel(quad.graph),
    ),
  );
}

function stripDefaultStringType<T>(value: T): T {
  if (Array.isArray(value)) {
    return value.map(stripDefaultStringType) as T;
  }
  if (value && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    if (
      record['@value'] !== undefined &&
      record['@type'] === xsd.string.value
    ) {
      const { ['@type']: _, ...rest } = record;
      return rest as T;
    }
    const result: Record<string, unknown> = {};
    for (const key of Object.keys(record)) {
      result[key] = stripDefaultStringType(record[key]);
    }
    return result as T;
  }
  return value;
}
