import {
  AstFactory,
  type Pattern,
  type PatternGroup,
  type PatternUnion,
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
 * Injects a VALUES clause at the innermost sub-SELECT, for per-item (selector)
 * bindings only, so that SPARQL engines can constrain scans early. When that
 * WHERE clause is a single UNION whose branches all bind the VALUES variables
 * in a required triple pattern, the VALUES goes into each branch instead:
 * engines such as QLever plan and evaluate each branch without the outer
 * VALUES otherwise.
 *
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
