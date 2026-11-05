import { createHash } from 'node:crypto';

/**
 * Mint a deterministic IRI for an otherwise-anonymous structural node — a PROV
 * `Activity`/`Usage`, a DQV measurement, a `void:Linkset`, a `void:subset` or a
 * `void:*Partition` — by extending a `base` IRI that is already unique within
 * the dataset's graph (typically the dataset IRI or one of its subsets) with
 * `-`-joined `suffixes`.
 *
 * Use this instead of a blank node for any such node. A dataset's graph is
 * assembled from the output of several independent pipeline stages, and
 * blank-node labels are not preserved across separately serialised documents:
 * two stages' `_:b0` collapse into one node when the documents are merged into
 * one graph, silently fusing unrelated provenance, measurements and linksets
 * (see dataset-knowledge-graph issue #352). IRIs are never relabelled, so
 * deriving every structural node from a unique base keeps distinct nodes
 * distinct across stages and makes a re-run idempotent rather than additive —
 * and lets a later stage address (and extend) a subset or partition another
 * stage emitted.
 *
 * Pass opaque, possibly non-IRI-safe `suffixes` (e.g. a URL) through
 * {@link hashSuffix} first.
 */
export function skolemIri(base: string, ...suffixes: string[]): string {
  return [base, ...suffixes].join('-');
}

/**
 * An md5 hex digest, for embedding an opaque value (e.g. a URL) as a stable,
 * IRI-safe segment in a {@link skolemIri}.
 */
export function hashSuffix(value: string): string {
  return createHash('md5').update(value).digest('hex');
}
