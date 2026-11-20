import {
  GraphQLError,
  Kind,
  locatedError,
  visit,
  type DocumentNode,
  type GraphQLFieldExtensions,
} from 'graphql';
import type { Plugin } from 'graphql-yoga';
import { facetQueryText } from '@lde/search';
import {
  fieldExtensionsEstimator,
  getComplexity,
  simpleEstimator,
} from 'graphql-query-complexity';

/**
 * Rejects an operation costlier than `maxCost`, where the cost counts the
 * engine work a query asks for rather than the shape of its selection: each
 * search, each lookup a joined reference triggers (per target) and each facet
 * calculation costs {@link operationCost}; a plain stored field costs nothing at any depth,
 * because it is served from the hit. `buildGraphQLSchema` puts these
 * costs on the fields; a custom field merged in costs nothing.
 *
 * A selection under `@skip` or `@include` counts whatever its condition: the
 * engine fetches skipped lookups too, because the projection does not evaluate
 * those directives.
 *
 * Measured at execution, not validation, because measuring coerces the
 * request’s variables, which a validation rule does not see.
 */
export function queryCostPlugin(maxCost: number): Plugin {
  if (!Number.isInteger(maxCost) || maxCost < 0) {
    throw new Error(`maxCost must be a non-negative integer; got ${maxCost}.`);
  }
  return {
    onExecute({ args, setResultAndStopExecution }) {
      let cost: number;
      try {
        cost = getComplexity({
          schema: args.schema,
          query: withoutConditions(args.document),
          variables: args.variableValues ?? undefined,
          // Yoga has already rejected a name that picks no operation.
          operationName: args.operationName ?? undefined,
          estimators: [
            fieldExtensionsEstimator(),
            simpleEstimator({ defaultComplexity: 0 }),
          ],
        });
      } catch (error) {
        // Invalid variables, or a query too large to measure: either way, it
        // does not run. Yoga passes a GraphQLError on and masks anything else
        // as an unexpected error.
        setResultAndStopExecution({ errors: [locatedError(error, undefined)] });
        return;
      }
      if (cost > maxCost) {
        setResultAndStopExecution({
          errors: [
            new GraphQLError(
              `Query costs ${cost}; at most ${maxCost} is allowed. Each search, facet calculation and joined reference lookup per target type costs ${operationCost}, and a query on a reference facet ${operationCost} more.`,
            ),
          ],
        });
      }
    },
  };
}

/** What one engine operation – a search, a lookup, a facet – costs. */
export const operationCost = 1;

/**
 * The field extensions that make a field cost `cost` on top of what is
 * selected below it.
 */
export function costExtensions(
  cost: number,
): GraphQLFieldExtensions<unknown, unknown> {
  return { complexity: cost };
}

/**
 * The field extensions of a reference facet that takes a `query`: `own` facet
 * calculations, and under a query one more – the search for its candidates and
 * the request that counts them.
 */
export function facetQueryCostExtensions(
  own: number,
): GraphQLFieldExtensions<unknown, unknown> {
  return {
    complexity: ({
      args,
      childComplexity,
    }: {
      args: { query?: string | null };
      childComplexity: number;
    }) =>
      childComplexity +
      operationCost *
        (own + (facetQueryText(args.query ?? undefined) === undefined ? 0 : 1)),
  };
}

/**
 * `document` without its directives, which validation has limited to `@skip`
 * and `@include`: the only executable directives the schema has.
 */
function withoutConditions(document: DocumentNode): DocumentNode {
  return visit(document, { [Kind.DIRECTIVE]: () => null });
}
