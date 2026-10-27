import {
  AstFactory,
  type Pattern,
  type PatternGroup,
  type PatternUnion,
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
 * For flat queries (no SubSelect), the base case injects directly: in front of
 * the WHERE clause, or into each branch when it is a single UNION whose branches
 * all qualify (see {@link bindsAllVariables}).
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
    // Base case: no SubSelect – inject here, into each UNION branch if safe.
    const branches =
      where.patterns.length === 1 && F.isPatternUnion(where.patterns[0])
        ? (where.patterns[0] as PatternUnion).patterns
        : [];
    if (
      branches.length > 0 &&
      branches.every((branch) => bindsAllVariables(branch, valuesPattern))
    ) {
      return F.patternGroup(
        [
          F.patternUnion(
            branches.map((branch) =>
              F.patternGroup([valuesPattern, ...branch.patterns], F.gen()),
            ),
            F.gen(),
          ),
        ],
        F.gen(),
      );
    }

    return F.patternGroup([valuesPattern, ...where.patterns], F.gen());
  }

  return F.patternGroup(mapped, F.gen());
}

/**
 * Whether a UNION branch binds every VALUES variable in a triple pattern of a
 * top-level BGP that precedes the branch’s first OPTIONAL, MINUS, BIND or other
 * non-FILTER pattern. Those apply to the solutions before them, so only then
 * does joining the VALUES first in the branch return the same solutions as
 * joining it outside the UNION. FILTERs apply to the whole group, wherever they are.
 */
function bindsAllVariables(
  branch: PatternGroup,
  valuesPattern: PatternValues,
): boolean {
  const bound = new Set<string>();
  for (const pattern of branch.patterns) {
    if (pattern.subType === 'filter') continue;
    if (!F.isPatternBgp(pattern)) break;
    for (const triple of pattern.triples) {
      if (triple.type !== 'triple') continue;
      for (const term of [triple.subject, triple.predicate, triple.object]) {
        if (F.isTermVariable(term)) bound.add(term.value);
      }
    }
  }

  return valuesPattern.variables.every((variable) => bound.has(variable.value));
}

/**
 * Inject a VALUES clause into a parsed CONSTRUCT query for the given binding rows.
 *
 * Each row's keys become SPARQL variables; NamedNode values become IRIs in the
 * VALUES block. The VALUES clause is injected into the innermost subquery so
 * that SPARQL engines can constrain scans early. When that WHERE clause is a
 * single UNION whose branches all bind the VALUES variables in a required
 * triple pattern, the VALUES goes into each branch instead: engines such as
 * QLever plan and evaluate each branch without the outer VALUES otherwise.
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
