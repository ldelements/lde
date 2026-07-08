import {
  aliasVariants,
  canonicalizeIri,
  type NamespaceAlias,
  type Reader,
  type VariableBindings,
} from '@lde/pipeline';
import { assertSafeIri } from '@lde/dataset';
import { DataFactory } from 'n3';

const { namedNode } = DataFactory;

/**
 * Marker in a VoID query template that expands to a SPARQL expression
 * normalizing the named raw variable to its canonical namespace, e.g.
 * `BIND(#normalized:rawClass# AS ?class)`. With no aliases configured the
 * marker expands to the raw variable itself.
 */
const NORMALIZATION_MARKER = /#normalized:([A-Za-z][A-Za-z0-9]*)#/g;

/**
 * Replace every {@link NORMALIZATION_MARKER} in a query template with the
 * normalization expression for its raw variable.
 */
export function substituteNormalizationMarkers(
  query: string,
  namespaceAliases: readonly NamespaceAlias[],
): string {
  return query.replace(NORMALIZATION_MARKER, (_match, rawVariable: string) =>
    normalizedExpression(rawVariable, namespaceAliases),
  );
}

/**
 * Canonicalize and deduplicate the `?class` bindings a class selector
 * yields, so every namespace-alias variant of a class becomes one item and
 * its variants are queried together in one batch (split across batches,
 * each batch would emit its own partial counts for the same partition IRI).
 */
export async function* canonicalizeClassBindings(
  rows: AsyncIterable<VariableBindings>,
  namespaceAliases: readonly NamespaceAlias[],
): AsyncIterable<VariableBindings> {
  const seen = new Set<string>();
  for await (const row of rows) {
    const canonical = canonicalizeIri(row.class.value, namespaceAliases);
    if (seen.has(canonical)) continue;
    seen.add(canonical);
    yield { class: namedNode(canonical) };
  }
}

/**
 * Decorate a {@link Reader} so each canonical `?class` binding is expanded to
 * one `?class` binding per namespace-alias variant. The per-class VoID queries
 * match `?s a ?class`, so this makes them pick up instances typed under either
 * namespace; the partition-merge transform then collapses the variants. The
 * expansion happens within one executor call, so the variants of a class are
 * co-located in a single batch — a prerequisite for the per-stage merge.
 */
export function withAliasVariantBindings(
  inner: Reader,
  namespaceAliases: readonly NamespaceAlias[],
): Reader {
  return {
    read(dataset, distribution, options) {
      const bindings = options?.bindings?.flatMap((row) =>
        aliasVariants(row.class.value, namespaceAliases).map((iri) => ({
          class: namedNode(iri),
        })),
      );
      return inner.read(dataset, distribution, { ...options, bindings });
    },
  };
}

/**
 * SPARQL expression rewriting `?rawVariable` from any alias namespace to its
 * canonical namespace: nested `IF(STRSTARTS(...), IRI(CONCAT(...)), ...)`
 * per alias, or the bare variable when no aliases are configured.
 */
function normalizedExpression(
  rawVariable: string,
  namespaceAliases: readonly NamespaceAlias[],
): string {
  let expression = `?${rawVariable}`;
  // Build from the inside out so the first alias is the outermost check.
  for (const { canonical, alias } of [...namespaceAliases].reverse()) {
    assertSafeSparqlString(canonical);
    assertSafeSparqlString(alias);
    expression = `IF(STRSTARTS(STR(?${rawVariable}), "${alias}"), IRI(CONCAT("${canonical}", STRAFTER(STR(?${rawVariable}), "${alias}"))), ${expression})`;
  }
  return expression;
}

/**
 * Namespaces are interpolated into double-quoted SPARQL string literals, so
 * beyond {@link assertSafeIri} they must not contain quotes or backslashes.
 */
function assertSafeSparqlString(namespace: string): void {
  assertSafeIri(namespace);
  if (namespace.includes('"') || namespace.includes('\\')) {
    throw new Error(
      `Namespace contains unsafe characters and cannot be interpolated into SPARQL: ${namespace}`,
    );
  }
}
