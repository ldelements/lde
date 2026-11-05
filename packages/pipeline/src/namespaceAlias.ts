/**
 * Declares that two namespaces should be treated as equivalent, working
 * around vocabularies that publish under both HTTP and HTTPS variants of the
 * same IRI (notably schema.org).
 */
export interface NamespaceAlias {
  /**
   * The namespace IRIs should be normalized to (e.g. `https://schema.org/`).
   */
  canonical: string;
  /**
   * The equivalent namespace that may appear in source data (e.g.
   * `http://schema.org/`).
   */
  alias: string;
}

/**
 * Rewrite an IRI in an alias namespace to its canonical form. IRIs outside
 * every alias namespace are returned unchanged.
 */
export function canonicalizeIri(
  iri: string,
  namespaceAliases: readonly NamespaceAlias[],
): string {
  for (const { canonical, alias } of namespaceAliases) {
    if (iri.startsWith(alias)) {
      return canonical + iri.slice(alias.length);
    }
  }
  return iri;
}

/**
 * All equivalent forms of an IRI under the given aliases: the IRI itself
 * plus, when it falls in a canonical or alias namespace, the counterpart in
 * the other namespace.
 */
export function aliasVariants(
  iri: string,
  namespaceAliases: readonly NamespaceAlias[],
): string[] {
  for (const { canonical, alias } of namespaceAliases) {
    if (iri.startsWith(canonical)) {
      return [iri, alias + iri.slice(canonical.length)];
    }
    if (iri.startsWith(alias)) {
      return [iri, canonical + iri.slice(alias.length)];
    }
  }
  return [iri];
}
