import {
  AstFactory,
  type Pattern,
  type PatternGroup,
  type PatternValues,
  type QueryConstruct,
  type QuerySelect,
  type ValuePatternRow,
} from '@traqula/rules-sparql-1-1';
import type { VariableBindings } from './reader.js';

const F = new AstFactory();

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

/**
 * Inject a VALUES clause into a parsed CONSTRUCT query for the given binding rows.
 *
 * Each row's keys become SPARQL variables; NamedNode values become IRIs in the
 * VALUES block. The VALUES clause is injected into the innermost subquery so
 * that SPARQL engines can constrain scans early.
 *
 * The caller owns parsing and stringifying; this function operates on the AST.
 */
export function injectValues(
  query: QueryConstruct,
  bindings: VariableBindings[],
): QueryConstruct {
  const variableNames = bindings.length > 0 ? Object.keys(bindings[0]) : [];

  const variables = variableNames.map((name) => F.termVariable(name, F.gen()));

  const values: ValuePatternRow[] = bindings.map((row) =>
    Object.fromEntries(
      Object.entries(row).map(([name, node]) => [
        name,
        F.termNamed(F.gen(), node.value),
      ]),
    ),
  );

  const valuesPattern = F.patternValues(variables, values, F.gen());

  return {
    ...query,
    where: injectIntoInnermost(query.where, valuesPattern),
  };
}
