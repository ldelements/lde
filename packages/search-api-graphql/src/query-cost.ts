import {
  GraphQLError,
  locatedError,
  type GraphQLFieldExtensions,
} from 'graphql';
import type { Plugin } from 'graphql-yoga';
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
 * Measured at execution, not validation: yoga caches validation results per
 * document, while the cost depends on the variables of each request
 * (`@skip`/`@include`).
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
          query: args.document,
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
        // does not run. Yoga masks anything that is not a GraphQLError.
        setResultAndStopExecution({ errors: [locatedError(error, undefined)] });
        return;
      }
      if (cost > maxCost) {
        setResultAndStopExecution({
          errors: [
            new GraphQLError(
              `Query costs ${cost}; at most ${maxCost} is allowed. Each search, joined reference lookup and facet costs ${operationCost}.`,
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
