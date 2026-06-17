import type { Quad } from '@rdfjs/types';

/**
 * A flat Typesense document. `id` is required (Typesense uses it as the document
 * key); every other field is engine-typed scalar data or an array thereof.
 */
export type TypesenseDocument = { id: string } & Record<string, unknown>;

export type FrameFieldType =
  | 'string'
  | 'string[]'
  | 'int'
  | 'float'
  | 'bool'
  | 'unixtime';

/**
 * Maps one document field to a single RDF predicate on the framed subject.
 * This is the generic, engine-agnostic half of projection — straight
 * predicate-to-field mappings with datatype coercion. Domain-specific
 * derivations (folding, grouping, cross-graph joins) are the consumer’s job.
 */
export interface FrameField {
  readonly field: string;
  readonly predicate: string;
  readonly type: FrameFieldType;
}

/**
 * Frame the quads describing one subject into a flat document, pulling each
 * configured field’s value(s) from its predicate and coercing to the field’s
 * type. Single-valued fields take the first object; `string[]` collects all.
 * Predicates with no matching quad are omitted (left to Typesense optionality).
 */
export function frame(
  quads: Iterable<Quad>,
  subject: string,
  fields: readonly FrameField[],
): TypesenseDocument {
  const objectsByPredicate = new Map<string, string[]>();
  for (const quad of quads) {
    if (quad.subject.value !== subject) {
      continue;
    }
    const values = objectsByPredicate.get(quad.predicate.value) ?? [];
    values.push(quad.object.value);
    objectsByPredicate.set(quad.predicate.value, values);
  }

  const document: TypesenseDocument = { id: subject };
  for (const { field, predicate, type } of fields) {
    const values = objectsByPredicate.get(predicate);
    if (values === undefined || values.length === 0) {
      continue;
    }
    const coerced = coerce(values, type);
    // Drop fields whose value did not parse (e.g. a non-numeric `int`), so a
    // bad triple omits the field rather than writing NaN, which Typesense
    // rejects for a typed numeric field.
    if (coerced !== undefined) {
      document[field] = coerced;
    }
  }
  return document;
}

function coerce(values: string[], type: FrameFieldType): unknown {
  switch (type) {
    case 'string':
      return values[0];
    case 'string[]':
      return values;
    case 'int':
      return finiteOrUndefined(Math.trunc(Number(values[0])));
    case 'float':
      return finiteOrUndefined(Number(values[0]));
    case 'bool':
      return values[0] === 'true' || values[0] === '1';
    case 'unixtime':
      return finiteOrUndefined(
        Math.trunc(new Date(values[0]).getTime() / 1000),
      );
  }
}

function finiteOrUndefined(value: number): number | undefined {
  return Number.isNaN(value) ? undefined : value;
}
