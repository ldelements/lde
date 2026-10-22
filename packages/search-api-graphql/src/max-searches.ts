import {
  GraphQLError,
  Kind,
  type SelectionSetNode,
  type ValidationContext,
  type ValidationRule,
} from 'graphql';
import type { Plugin } from 'graphql-yoga';

/**
 * Rejects an operation that selects more than `maxSearches` root fields. Each
 * root field runs its own engine search (plus a facet round-trip), and
 * graphql-armor’s cost limit cannot see that: it scales only with `first` and
 * `last`, so aliases of one search field cost little while each searches anew.
 */
export function maxSearchesPlugin(maxSearches: number): Plugin {
  if (!Number.isInteger(maxSearches) || maxSearches < 1) {
    throw new Error(
      `maxSearches must be a positive integer; got ${maxSearches}.`,
    );
  }
  return {
    onValidate({ addValidationRule }) {
      addValidationRule(maxSearchesRule(maxSearches));
    },
  };
}

function maxSearchesRule(maxSearches: number): ValidationRule {
  return (context) => ({
    OperationDefinition(operation) {
      const rootFields = rootResponseKeys(
        operation.selectionSet,
        context,
        new Set(),
      ).size;
      if (rootFields > maxSearches) {
        context.reportError(
          new GraphQLError(
            `Query selects ${rootFields} root fields; at most ${maxSearches} are allowed, as each may run a search.`,
            { nodes: operation },
          ),
        );
      }
    },
  });
}

/**
 * The response keys of an operation’s root fields, with fragments flattened.
 * A key, not a field, is what runs: graphql-js merges selections sharing one
 * key into a single execution, while every alias executes on its own.
 */
function rootResponseKeys(
  selectionSet: SelectionSetNode,
  context: ValidationContext,
  visitedFragments: Set<string>,
  keys = new Set<string>(),
): Set<string> {
  for (const selection of selectionSet.selections) {
    if (selection.kind === Kind.FIELD) {
      if (!selection.name.value.startsWith('__')) {
        keys.add(selection.alias?.value ?? selection.name.value);
      }
    } else if (selection.kind === Kind.INLINE_FRAGMENT) {
      rootResponseKeys(selection.selectionSet, context, visitedFragments, keys);
    } else if (!visitedFragments.has(selection.name.value)) {
      visitedFragments.add(selection.name.value);
      const fragment = context.getFragment(selection.name.value);
      if (fragment) {
        rootResponseKeys(
          fragment.selectionSet,
          context,
          visitedFragments,
          keys,
        );
      }
    }
  }
  return keys;
}
