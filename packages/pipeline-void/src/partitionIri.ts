import { createHash } from 'node:crypto';

/**
 * Single source of truth for the VoID partition-IRI scheme
 * (`<dataset>/.well-known/void#<prefix>-<MD5(component…)>`), shared by two
 * derivations that must agree byte-for-byte:
 *
 * - {@link mintPartitionIri} mints an IRI in TypeScript (used by the
 *   partition-merge transform to re-key a partition to its canonical form);
 * - {@link substituteMintMarkers} generates the equivalent SPARQL `BIND` value
 *   expression, injected into the analysis queries in place of `#mint:<kind>#`.
 *
 * Because both come from {@link PARTITION_KINDS}, a change to the scheme (a
 * prefix, a component, its order) updates the query minting and the TS minting
 * together — they cannot silently diverge.
 */

/** The `/.well-known/void#` path under a dataset IRI where partitions live. */
const WELL_KNOWN_VOID = '/.well-known/void#';

/**
 * Each partition kind's IRI prefix and the ordered SPARQL string expressions
 * whose MD5 hash keys it. The queries must bind the standard component
 * variables (`?class`, `?p`, `?dt`, `?objectClass`, `?lang`).
 */
const PARTITION_KINDS = {
  class: ['STR(?class)'],
  'class-property': ['STR(?class)', 'STR(?p)'],
  datatype: ['STR(?class)', 'STR(?p)', 'STR(?dt)'],
  'object-class': ['STR(?class)', 'STR(?p)', 'STR(?objectClass)'],
  // ?lang is a plain string literal, so it is hashed without STR().
  language: ['STR(?class)', 'STR(?p)', '?lang'],
} as const;

/** A VoID partition kind; also its IRI prefix. */
export type PartitionKind = keyof typeof PARTITION_KINDS;

/**
 * Mint a partition IRI from its canonical component *string values* (the class
 * IRI, property IRI, datatype IRI, or language tag — the `STR()` forms the
 * SPARQL side concatenates). The TypeScript counterpart of the query minting.
 */
export function mintPartitionIri(
  datasetIri: string,
  kind: PartitionKind,
  components: readonly string[],
): string {
  const hash = createHash('md5').update(components.join('')).digest('hex');
  return `${datasetIri}${WELL_KNOWN_VOID}${kind}-${hash}`;
}

/**
 * Replace every `#mint:<kind>#` marker in a query with the SPARQL value
 * expression that mints that kind's partition IRI, e.g.
 * `URI(CONCAT(STR(?dataset), "/.well-known/void#class-", MD5(STR(?class))))`.
 */
export function substituteMintMarkers(query: string): string {
  return query.replace(/#mint:([a-z-]+)#/g, (_match, kind: string) => {
    const components = PARTITION_KINDS[kind as PartitionKind];
    if (components === undefined) {
      throw new Error(`Unknown partition kind in #mint:# marker: ${kind}`);
    }
    const hashed =
      components.length === 1
        ? components[0]
        : `CONCAT(${components.join(', ')})`;
    return `URI(CONCAT(STR(?dataset), "${WELL_KNOWN_VOID}${kind}-", MD5(${hashed})))`;
  });
}
