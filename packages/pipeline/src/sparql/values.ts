import {
  AstFactory,
  type Pattern,
  type PatternGroup,
  type PatternValues,
  type QueryConstruct,
  type QuerySelect,
  type TermIri,
  type TermLiteral,
  type ValuePatternRow,
} from '@traqula/rules-sparql-1-1';
import type { NamedNode, Literal } from '@rdfjs/types';
import type { VariableBindings } from './reader.js';

const F = new AstFactory();

function termToAstTerm(node: NamedNode | Literal): TermIri | TermLiteral {
  if (node.termType === 'Literal') {
    return node.language
      ? F.termLiteral(F.gen(), node.value, node.language)
      : F.termLiteral(F.gen(), node.value);
  }
  return F.termNamed(F.gen(), node.value);
}

/**
 * Find the first SubSelect within a list of patterns, looking through
 * intermediate group patterns (the parser wraps `{ SELECT }` in a group).
 */
export function findSubSelect(patterns: Pattern[]): QuerySelect | undefined {
  for (const pattern of patterns) {
    if (F.isQuerySelect(pattern)) {
      return pattern as QuerySelect;
    }
    if (pattern.subType === 'group') {
      const found = findSubSelect((pattern as PatternGroup).patterns);
      if (found) return found;
    }
  }
  return undefined;
}

/**
 * Single-pass find-and-replace: walk through patterns to locate the SubSelect
 * (looking through group wrappers) and return a new array with it replaced.
 * Returns `undefined` if no SubSelect was found.
 */
function mapSubSelect(
  patterns: Pattern[],
  replacer: (subSelect: QuerySelect) => QuerySelect,
): Pattern[] | undefined {
  for (let index = 0; index < patterns.length; index++) {
    const pattern = patterns[index];

    if (F.isQuerySelect(pattern)) {
      const newPatterns = [...patterns];
      newPatterns[index] = replacer(pattern as QuerySelect);
      return newPatterns;
    }

    if (pattern.subType === 'group') {
      const group = pattern as PatternGroup;
      const innerResult = mapSubSelect(group.patterns, replacer);
      if (innerResult) {
        const newPatterns = [...patterns];
        newPatterns[index] = F.patternGroup(innerResult, F.gen());
        return newPatterns;
      }
    }
  }
  return undefined;
}

/**
 * Recursively walk through nested SubSelect patterns and inject the VALUES
 * clause into the innermost WHERE clause. This ensures that SPARQL engines
 * constrain scans at the deepest level rather than only at the outer scope.
 *
 * For flat queries (no SubSelect), the base case injects directly — identical
 * to the previous behavior.
 */
function injectIntoInnermost(
  where: PatternGroup,
  valuesPattern: PatternValues,
): PatternGroup {
  const mapped = mapSubSelect(where.patterns, (subSelect) => ({
    ...subSelect,
    where: injectIntoInnermost(subSelect.where, valuesPattern),
  }));

  if (!mapped) {
    // Base case: no SubSelect — inject here.
    return F.patternGroup([valuesPattern, ...where.patterns], F.gen());
  }

  return F.patternGroup(mapped, F.gen());
}

function buildValuesPattern(bindings: VariableBindings[]): PatternValues {
  const variableNames = bindings.length > 0 ? Object.keys(bindings[0]) : [];

  const variables = variableNames.map((name) => F.termVariable(name, F.gen()));

  const values: ValuePatternRow[] = bindings.map((row) =>
    Object.fromEntries(
      Object.entries(row).map(([name, node]) => [name, termToAstTerm(node)]),
    ),
  );

  return F.patternValues(variables, values, F.gen());
}

/**
 * Injects at the innermost sub-SELECT, for per-item (selector) bindings only.
 * Dataset-level bindings must use {@link injectValuesOuter} instead – a
 * sub-SELECT doesn't inherit outer bindings, so injecting them here would
 * leave an outer `BIND`/`FILTER` referencing them unbound.
 */
export function injectValues<Q extends QueryConstruct | QuerySelect>(
  query: Q,
  bindings: VariableBindings[],
): Q {
  return {
    ...query,
    where: injectIntoInnermost(query.where, buildValuesPattern(bindings)),
  };
}

/**
 * Injects at the outermost WHERE scope, for dataset-level bindings (the
 * dataset IRI, DCAT bindings, custom {@link DatasetBindingsProvider} rows).
 * Not visible inside a nested sub-SELECT – see {@link injectValues}.
 */
export function injectValuesOuter<Q extends QueryConstruct | QuerySelect>(
  query: Q,
  bindings: VariableBindings[],
): Q {
  return {
    ...query,
    where: F.patternGroup(
      [buildValuesPattern(bindings), ...query.where.patterns],
      F.gen(),
    ),
  };
}

/**
 * Cross-products two sets of dataset-level binding rows (predefined DCAT
 * bindings and a custom {@link DatasetBindingsProvider}'s rows), for
 * {@link injectValuesOuter}. An empty side is the identity. This is also how
 * a multi-valued binding like `datasetLanguage` ends up as one row per value.
 */
export function mergeBindings(
  a: VariableBindings[],
  b: VariableBindings[],
): VariableBindings[] {
  if (a.length === 0) return b;
  if (b.length === 0) return a;

  const merged: VariableBindings[] = [];
  for (const rowA of a) {
    for (const rowB of b) {
      merged.push({ ...rowA, ...rowB });
    }
  }
  return merged;
}
