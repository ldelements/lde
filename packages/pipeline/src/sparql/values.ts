import {
  AstFactory,
  type Pattern,
  type PatternBind,
  type PatternGroup,
  type PatternUnion,
  type PatternValues,
  type QueryConstruct,
  type QuerySelect,
  type SolutionModifierGroup,
  type TermIri,
  type TermLiteral,
  type TermVariable,
  type ValuePatternRow,
} from '@traqula/rules-sparql-1-1';
import type { NamedNode, Literal } from '@rdfjs/types';
import { termToString } from 'rdf-string';
import type { DatasetBindings } from './datasetBindings.js';
import type { VariableBindings } from './reader.js';
import { assertSafeIri } from '@lde/dataset';

const F = new AstFactory();
const XSD_STRING = 'http://www.w3.org/2001/XMLSchema#string';

function termToAstTerm(node: NamedNode | Literal): TermIri | TermLiteral {
  if (node.termType === 'Literal') {
    if (node.language) return F.termLiteral(F.gen(), node.value, node.language);
    if (node.datatype.value === XSD_STRING) {
      return F.termLiteral(F.gen(), node.value);
    }

    assertSafeIri(node.datatype.value);
    return F.termLiteral(
      F.gen(),
      node.value,
      F.termNamed(F.gen(), node.datatype.value),
    );
  }

  // The generator writes IRIs into the query unescaped.
  assertSafeIri(node.value);
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
  const variableNames = [...new Set(bindings.flatMap(Object.keys))];

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
 * Dataset-level bindings must use {@link injectDatasetBindings} instead – a
 * sub-SELECT doesn't inherit outer bindings, so injecting them here would
 * leave an outer `BIND`/`FILTER` referencing them unbound.
 */
export function injectValues(
  query: QueryConstruct,
  bindings: VariableBindings[],
): QueryConstruct {
  return {
    ...query,
    where: injectIntoInnermost(query.where, buildValuesPattern(bindings)),
  };
}

/**
 * The variables in an AST node that a binding at the outermost scope can reach.
 * Of a sub-SELECT only the projection counts, because the rest is out of scope.
 */
function visibleVariables(node: unknown): string[] {
  if (Array.isArray(node)) return node.flatMap(visibleVariables);
  if (typeof node !== 'object' || node === null) return [];
  if (F.isTermVariable(node)) return [(node as TermVariable).value];
  if (F.isQuerySelect(node)) return projectedVariables(node as QuerySelect);

  return visibleVariables(Object.values(node));
}

function projectedVariables(subSelect: QuerySelect): string[] {
  return subSelect.variables.flatMap((projected) => {
    if (F.isWildcard(projected)) return visibleVariables(subSelect.where);
    if (F.isTermVariable(projected)) return [projected.value];

    return [projected.variable.value];
  });
}

/**
 * The variables in an AST node that the query assigns itself where a binding at
 * the outermost scope can reach them: with `BIND(… AS ?x)`, `(… AS ?x)` in a
 * projection or `GROUP BY`, or `VALUES`. Of a sub-SELECT only the variables it
 * projects count, as for {@link visibleVariables}.
 */
function assignedVariables(node: unknown): string[] {
  if (Array.isArray(node)) return node.flatMap(assignedVariables);
  if (typeof node !== 'object' || node === null) return [];
  if (F.isQuerySelect(node)) {
    const subSelect = node as QuerySelect;
    const assigned = new Set(assignedVariables(Object.values(subSelect)));
    return projectedVariables(subSelect).filter((variable) =>
      assigned.has(variable),
    );
  }
  if (F.isPatternBind(node)) {
    const bind = node as PatternBind;
    return [bind.variable.value, ...assignedVariables(bind.expression)];
  }
  if (F.isPatternValues(node)) {
    return (node as PatternValues).variables.map((variable) => variable.value);
  }
  if (F.isSolutionModifierGroup(node)) {
    return (node as SolutionModifierGroup).groupings.flatMap((grouping) =>
      'variable' in grouping
        ? [grouping.variable.value, ...assignedVariables(grouping.value)]
        : assignedVariables(grouping),
    );
  }

  return assignedVariables(Object.values(node));
}

/** A key that is equal for rows binding the same variables to the same terms. */
function rowKey(row: VariableBindings): string {
  return JSON.stringify(
    Object.entries(row)
      .map(([name, term]) => [name, termToString(term)])
      .sort(([a], [b]) => a.localeCompare(b)),
  );
}

/**
 * Narrows rows to the given variables, dropping rows that become equal. A row
 * that becomes empty stays (as UNDEF), so the group still allows its variables
 * to be unbound, unless every row does: then the query doesn't use the group.
 */
function narrowRows(
  rows: VariableBindings[],
  variables: ReadonlySet<string>,
): VariableBindings[] {
  const narrowed = rows.map((row) =>
    Object.fromEntries(
      Object.entries(row).filter(([name]) => variables.has(name)),
    ),
  );
  if (narrowed.every((row) => Object.keys(row).length === 0)) return [];

  return [...new Map(narrowed.map((row) => [rowKey(row), row])).values()];
}

function overlaps(a: ReadonlySet<string>, b: ReadonlySet<string>): boolean {
  return [...a].some((variable) => b.has(variable));
}

/**
 * Whether a multi-row group can get its own `UNION` branch: the query only
 * outputs its variables, in template triples without another group's variables.
 */
function canBranch(
  rows: VariableBindings[],
  multiRowGroups: VariableBindings[][],
  usedOutsideTemplate: ReadonlySet<string>,
  templateTriples: readonly ReadonlySet<string>[],
): boolean {
  const own = new Set(rows.flatMap(Object.keys));
  const others = new Set(
    multiRowGroups
      .filter((group) => group !== rows)
      .flat()
      .flatMap(Object.keys),
  );

  return (
    !overlaps(own, usedOutsideTemplate) &&
    !templateTriples.some(
      (variables) => overlaps(variables, own) && overlaps(variables, others),
    )
  );
}

/** One group needs no `UNION`; several each get their own branch. */
function buildBranchPatterns(branches: VariableBindings[][]): Pattern[] {
  if (branches.length === 0) return [];
  if (branches.length === 1) return [buildValuesPattern(branches[0])];

  return [
    F.patternUnion(
      branches.map((rows) =>
        F.patternGroup([buildValuesPattern(rows)], F.gen()),
      ),
      F.gen(),
    ),
  ];
}

/**
 * Where a query can take dataset-level bindings – see
 * {@link identifyDatasetBindings}.
 */
export interface DatasetBindingTargets {
  /** The variables the query references and doesn't assign itself. */
  readonly variables: ReadonlySet<string>;
  /** Of those, the ones used outside the `CONSTRUCT` template. */
  readonly usedOutsideTemplate: ReadonlySet<string>;
  /** The variables of each `CONSTRUCT` template triple. */
  readonly templateTriples: readonly ReadonlySet<string>[];
}

/**
 * Identifies which variables of a query {@link injectDatasetBindings} can bind,
 * and how the query uses them. It depends only on the query, so a caller that
 * injects into the same query repeatedly can identify them once.
 *
 * A variable the query assigns itself, with `BIND(… AS ?x)` or `(… AS ?x)`, is
 * left out: the query's own value takes precedence, and an outer binding would
 * make the assignment invalid SPARQL.
 */
export function identifyDatasetBindings(
  query: QueryConstruct | QuerySelect,
): DatasetBindingTargets {
  const { template, ...clauses } = query as typeof query &
    Partial<QueryConstruct>;
  const assigned = new Set(assignedVariables(Object.values(clauses)));
  const bindable = (variables: string[]) =>
    new Set(variables.filter((variable) => !assigned.has(variable)));

  const templateTriples = (template?.triples ?? []).map((triple) =>
    bindable(visibleVariables(triple)),
  );
  const usedOutsideTemplate = bindable(
    visibleVariables(Object.values(clauses)),
  );

  return {
    variables: new Set([
      ...usedOutsideTemplate,
      ...templateTriples.flatMap((variables) => [...variables]),
    ]),
    usedOutsideTemplate,
    templateTriples,
  };
}

/**
 * Injects dataset-level bindings at the outermost WHERE scope, for the variables
 * the query references and doesn't assign itself (see
 * {@link identifyDatasetBindings}). A query that references none is returned
 * unchanged.
 *
 * Multi-row groups the query only outputs go in separate `UNION` branches, so
 * L languages and N names make L + N rows instead of L × N. Other multi-row
 * groups are joined: in another group's branch their variables would be unbound,
 * making patterns on them match too much and filters on them remove solutions.
 *
 * @param targets The query's {@link identifyDatasetBindings} result, when the
 *   caller has it already.
 */
export function injectDatasetBindings<Q extends QueryConstruct | QuerySelect>(
  query: Q,
  bindings: DatasetBindings,
  targets: DatasetBindingTargets = identifyDatasetBindings(query),
): Q {
  const { variables, usedOutsideTemplate, templateTriples } = targets;

  const groups = bindings
    .map((rows) => narrowRows(rows, variables))
    .filter((rows) => rows.length > 0);
  if (groups.length === 0) return query;

  const singleRows = groups.filter((rows) => rows.length === 1).flat();
  const multiRowGroups = groups.filter((rows) => rows.length > 1);

  const branches = multiRowGroups.filter((rows) =>
    canBranch(rows, multiRowGroups, usedOutsideTemplate, templateTriples),
  );
  const joined = multiRowGroups.filter((rows) => !branches.includes(rows));

  const injected = [
    ...(singleRows.length > 0
      ? [buildValuesPattern([Object.assign({}, ...singleRows)])]
      : []),
    ...joined.map((rows) => buildValuesPattern(rows)),
    ...buildBranchPatterns(branches),
  ];

  // A bare sub-SELECT (`WHERE { SELECT … }`) is only valid as a group's sole
  // content, so it needs its own braces once VALUES sits beside it.
  const patterns = query.where.patterns.map((pattern) =>
    F.isQuerySelect(pattern) ? F.patternGroup([pattern], F.gen()) : pattern,
  );

  return {
    ...query,
    where: F.patternGroup([...injected, ...patterns], F.gen()),
  };
}
