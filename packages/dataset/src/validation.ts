// eslint-disable-next-line no-control-regex -- intentionally matching control chars for IRI safety
const UNSAFE_IRI_CHARS = /[<>\s\x00-\x1f]/;

/**
 * Throw if `iri` contains characters that could break out of a SPARQL
 * `<…>` IRI reference (angle brackets, whitespace, or control characters).
 */
export function assertSafeIri(iri: string): void {
  if (UNSAFE_IRI_CHARS.test(iri)) {
    throw new Error(
      `IRI contains unsafe characters and cannot be interpolated into SPARQL: ${iri}`,
    );
  }
}
