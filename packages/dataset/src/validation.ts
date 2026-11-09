// The characters SPARQL’s IRIREF production excludes, plus any whitespace.
// eslint-disable-next-line no-control-regex -- intentionally matching control chars for IRI safety
const UNSAFE_IRI_CHARS = /[<>"{}|^`\\\s\x00-\x1f]/;

/**
 * Throw if `iri` contains characters that a SPARQL `<…>` IRI reference cannot
 * hold: angle brackets, `"`, `{`, `}`, `|`, `^`, `` ` ``, `\`, whitespace, or
 * control characters. Such an IRI would break, or escape from, the query it is
 * interpolated into.
 */
export function assertSafeIri(iri: string): void {
  if (UNSAFE_IRI_CHARS.test(iri)) {
    throw new Error(
      `IRI contains unsafe characters and cannot be interpolated into SPARQL: ${iri}`,
    );
  }
}
