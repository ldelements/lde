import { rdfDereferencer } from 'rdf-dereference';
import { JsonLdArray } from 'jsonld/jsonld-spec.js';
import jsonld from 'jsonld';
import { rdfSerializer } from 'rdf-serialize';
import streamToString from 'stream-to-string';
import { xsd } from '@tpluscode/rdf-ns-builders';

export async function parseRdfToJsonLd(filePath: string): Promise<JsonLdArray> {
  const { data } = await rdfDereferencer.dereference(filePath, {
    localFiles: true,
  });

  // Convert to n-quads, the only input format that the jsonld library takes.
  const nq = rdfSerializer.serialize(data, {
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
