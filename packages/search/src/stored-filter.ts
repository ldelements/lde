import {
  compileFilter,
  type Cql2Expression,
  type QueryableLookup,
} from '@lde/cql2';
import type { FilterMatcher, ProjectedNode } from './project.js';
import {
  isAbsoluteIri,
  isInlineReference,
  rootTypeNamed,
  type RootType,
  type SearchField,
  type SearchSchema,
} from './schema.js';

/**
 * A filter kept outside the schema – in a file, or in an application that lets
 * people save the searches they build – that marks every document it matches
 * with a value. The run tests each document as it projects it
 * ({@link compileStoredFilters}), so a document carries its values from the
 * moment it is searchable, and a query filters on them like on any other field.
 */
export interface StoredFilter {
  /** The `name` of the Root Type whose documents the filter tests. */
  readonly type: string;
  /**
   * What a matching document gets, in the type’s field declared
   * `from: 'matchedFilters'`. An absolute IRI where that field is a
   * `reference`. Several filters may share a value: a document matching any of
   * them gets it once.
   */
  readonly value: string;
  /**
   * The condition, in the part of CQL2 JSON `@lde/cql2` reads. A property is a
   * field of the type, by its declared `name`: a `keyword`, or a `reference`
   * that is not inline, declared before the field the value goes to. A
   * reference is compared by what it stores – for a keyed target its key.
   */
  readonly filter: Cql2Expression;
}

/**
 * Check stored filters against the schema and compile them into the
 * {@link FilterMatcher} a projection runs with
 * ({@link ProjectionContext.matchedFilters}).
 *
 * The filters are data from outside the program, so nothing about them is
 * assumed. Every mistake is collected and thrown as one error, before the first
 * document is read: a filter that is not CQL2 JSON this function reads, a type
 * the schema does not declare, that is keyed on a declared field or that
 * declares no `from: 'matchedFilters'` field, a value that field cannot store, a property that is not a `keyword`
 * or non-inline `reference` field declared before it, and an operator that
 * does not fit the field (`=` on an `array`, `a_contains` on a single value).
 */
export function compileStoredFilters(
  schema: SearchSchema,
  filters: unknown,
): FilterMatcher {
  if (!Array.isArray(filters)) {
    throw new Error('Stored filters must be a JSON array.');
  }
  const problems: string[] = [];
  const testsByType = new Map<string, CompiledStoredFilter[]>();
  filters.forEach((entry, index) => {
    const where = `Stored filter ${index + 1}`;
    const compiled = compileStoredFilter(schema, entry, where, problems);
    if (compiled !== undefined) {
      testsByType.set(compiled.type, [
        ...(testsByType.get(compiled.type) ?? []),
        compiled,
      ]);
    }
  });
  if (problems.length > 0) {
    throw new Error(problems.join('\n'));
  }
  return (searchType, document) =>
    (testsByType.get(searchType.name) ?? [])
      .filter(({ matches }) => matches(document))
      .map(({ value }) => value);
}

interface CompiledStoredFilter {
  readonly type: string;
  readonly value: string;
  readonly matches: (document: ProjectedNode) => boolean;
}

const STORED_FILTER_KEYS: readonly string[] = ['type', 'value', 'filter'];

function compileStoredFilter(
  schema: SearchSchema,
  entry: unknown,
  where: string,
  problems: string[],
): CompiledStoredFilter | undefined {
  if (!isObject(entry)) {
    problems.push(
      `${where} must be an object with “type”, “value” and “filter”.`,
    );
    return undefined;
  }
  const { type, value } = entry;
  if (typeof type !== 'string' || typeof value !== 'string' || value === '') {
    problems.push(
      `${where} must name a “type” and a non-empty “value”, both strings.`,
    );
    return undefined;
  }
  const unknownKeys = Object.keys(entry).filter(
    (key) => !STORED_FILTER_KEYS.includes(key),
  );
  if (unknownKeys.length > 0) {
    // Ignoring one would apply a filter that says less than its author meant.
    problems.push(
      `${where} has ${unknownKeys.map((key) => `“${key}”`).join(', ')}; a stored filter holds “type”, “value” and “filter” only.`,
    );
    return undefined;
  }
  const rootType = rootTypeNamed(schema, type);
  if (rootType === undefined) {
    problems.push(
      `${where} names type “${type}”, which is not a root type of the schema.`,
    );
    return undefined;
  }
  if (rootType.key !== undefined) {
    problems.push(
      `${where} names type “${type}”, which is keyed on “${rootType.key.field}”: several roots share one of its documents, which would hold the values of whichever root was written last.`,
    );
    return undefined;
  }
  const target = rootType.fields.find(
    (field) => 'from' in field && field.from === 'matchedFilters',
  );
  if (target === undefined) {
    problems.push(
      `${where} names type “${type}”, which declares no field “from: 'matchedFilters'” to hold its value.`,
    );
    return undefined;
  }
  if (target.kind === 'reference' && !isAbsoluteIri(value)) {
    problems.push(
      `${where} has value “${value}”, but “${type}.${target.name}” is a reference and stores absolute IRIs only.`,
    );
  }
  const compiled = compileFilter(entry.filter, queryablesOf(rootType, target));
  if (!compiled.ok) {
    problems.push(
      ...compiled.problems.map((problem) => `${where}: ${problem}`),
    );
    return undefined;
  }
  return { type, value, matches: compiled.matches };
}

/**
 * The fields of a type a stored filter may read, as `@lde/cql2` queryables: a
 * `keyword` or non-inline `reference` declared before the field the value is
 * written to – the document holds nothing later yet – that the projection
 * fills with strings. Only strings are compared, so a `derive` that returns a
 * number or a boolean matches nothing.
 */
function queryablesOf(
  rootType: RootType,
  target: SearchField,
): QueryableLookup {
  const targetPosition = rootType.fields.indexOf(target);
  return (name) => {
    const position = rootType.fields.findIndex((field) => field.name === name);
    const field = rootType.fields[position];
    if (field === undefined) {
      return { reason: `“${rootType.name}” declares no field “${name}”.` };
    }
    if (position >= targetPosition) {
      return {
        reason: `field “${name}” is not declared before “${target.name}”, so it has no value yet when the filter is tested.`,
      };
    }
    if (
      (field.kind !== 'keyword' && field.kind !== 'reference') ||
      isInlineReference(field)
    ) {
      return {
        reason: `field “${name}” cannot be filtered on; a stored filter reads keyword fields and references that are not inline.`,
      };
    }
    return {
      array: field.array === true,
      read: (document) => storedValues(document[name]),
    };
  };
}

/**
 * What a projected `keyword` or `reference` field holds: the stored value or
 * values, and for a referent nested by a `local` lookup its `id`.
 */
function storedValues(stored: unknown): unknown[] {
  return (Array.isArray(stored) ? stored : [stored]).map((value) =>
    isObject(value) ? value.id : value,
  );
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
