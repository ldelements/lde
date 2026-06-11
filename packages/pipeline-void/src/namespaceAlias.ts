import { assertSafeIri } from '@lde/dataset';

/**
 * A pair of namespace IRI prefixes that denote the same vocabulary, where
 * {@link alias} IRIs are to be treated as their {@link canonical} equivalents.
 *
 * The canonical example is schema.org, which datasets publish under both
 * `http://schema.org/` (historical) and `https://schema.org/` (current). To
 * RDF these are distinct IRIs, so without canonicalisation a dataset that
 * mixes both forms yields two `void:classPartition` nodes for what is
 * conceptually one class, each counted over a disjoint subset.
 */
export interface NamespaceAlias {
  /** The canonical namespace IRI prefix that {@link alias} IRIs are rewritten to. */
  canonical: string;
  /** The alias namespace IRI prefix, rewritten to {@link canonical}. */
  alias: string;
}

/**
 * Reject namespaces that could break out of the SPARQL string literals and
 * IRI references the canonicalisation expression interpolates them into.
 */
function assertSafeNamespace(namespace: string): void {
  assertSafeIri(namespace);
  if (namespace.includes('"') || namespace.includes('\\')) {
    throw new Error(
      `Namespace contains characters unsafe for a SPARQL string literal: ${namespace}`,
    );
  }
}

/**
 * A SPARQL expression that rewrites `?${rawVariable}` from any configured alias
 * namespace to its canonical form, leaving IRIs in no alias namespace
 * untouched. Aliases are tested in order; the first matching prefix wins.
 */
function canonicalizeExpression(
  rawVariable: string,
  aliases: readonly NamespaceAlias[],
): string {
  return aliases.reduceRight((otherwise, { canonical, alias }) => {
    assertSafeNamespace(canonical);
    assertSafeNamespace(alias);
    return `IF(STRSTARTS(STR(?${rawVariable}), "${alias}"), IRI(CONCAT("${canonical}", STRAFTER(STR(?${rawVariable}), "${alias}"))), ${otherwise})`;
  }, `?${rawVariable}`);
}

/**
 * `#typePattern(?subject, ?type)#` — match the type of `?subject`, binding the
 * canonical form to `?type`. Used where `?type` is grouped or derived (not
 * injected), so a plain `BIND` can assign it.
 */
const TYPE_PATTERN = /#typePattern\(\?(\w+),\s*\?(\w+)\)#/g;

/**
 * `#typePatternFiltered(?subject, ?type)#` — match the type of `?subject` and
 * keep only those whose canonical form equals `?type`. Used where `?type` is
 * supplied through an injected `VALUES` clause (the per-class stages): SPARQL
 * forbids `BIND(… AS ?type)` for an already-bound variable, so the canonical
 * form is bound to a helper variable and compared with `FILTER`.
 */
const TYPE_PATTERN_FILTERED = /#typePatternFiltered\(\?(\w+),\s*\?(\w+)\)#/g;

/**
 * Replace the type-pattern placeholders in a VoID query with patterns that
 * canonicalise alias-namespace types. With no aliases configured both
 * placeholders collapse to a plain `?subject a ?type .` triple, leaving the
 * query — and its performance — unchanged.
 */
export function applyNamespaceAliases(
  query: string,
  aliases: readonly NamespaceAlias[],
): string {
  const bindForm = (subject: string, type: string): string => {
    if (aliases.length === 0) return `?${subject} a ?${type} .`;
    const raw = `${type}Raw`;
    return `?${subject} a ?${raw} .\n    BIND(${canonicalizeExpression(raw, aliases)} AS ?${type})`;
  };
  const filterForm = (subject: string, type: string): string => {
    if (aliases.length === 0) return `?${subject} a ?${type} .`;
    const actual = `${type}Actual`;
    const canonical = `${type}Canonical`;
    return `?${subject} a ?${actual} .\n    BIND(${canonicalizeExpression(actual, aliases)} AS ?${canonical})\n    FILTER(?${canonical} = ?${type})`;
  };

  return query
    .replaceAll(TYPE_PATTERN, (_match, subject, type) =>
      bindForm(subject, type),
    )
    .replaceAll(TYPE_PATTERN_FILTERED, (_match, subject, type) =>
      filterForm(subject, type),
    );
}
