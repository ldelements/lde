# 7. Merge namespace-alias VoID partitions after aggregation

Date: 2026-07-08

## Status

Proposed

Extends the VoID analysis of
[ADR 2 (Unify pipeline extension on quad transforms)](./0002-unify-pipeline-extension-on-quad-transforms.md).

## Context

Some vocabularies publish under both an `http://` and an `https://`
variant of the same namespace — notably schema.org — and datasets mix
them. The VoID analysis keys each partition on an opaque
`MD5(class[, property[, …]])` IRI, so a dataset with both
`http://schema.org/CreativeWork` and `https://schema.org/CreativeWork`
produces **two** `void:classPartition` nodes that, once the class IRI is
normalized, describe the same class. Downstream consumers that group by
class URI do not expect two partitions for one class; the Dataset Register
browser crashed on the duplicate.

The consuming side cannot fix this from the published summary: merging two
pre-aggregated `void:entities` counts is only correct if the underlying
subject sets are disjoint, and merging two `void:distinctObjects` counts is
never correct from the counts alone (the object sets can overlap). Only the
analysis, which still has the raw data, can produce correct merged numbers.

Two placements were considered:

- **Normalize inside every query, before `GROUP BY`.** Correct without any
  assumptions, but weaves a per-row `BIND(IF(STRSTARTS…))` into all six
  partition queries and groups on a computed value rather than an indexed
  one.
- **Normalize once, after aggregation.** Keeps the queries plain and puts
  normalization in one testable place, at the cost of correctness
  assumptions where a distinct-count cannot be reconstructed by summing.

## Decision

Normalize after aggregation with a single **partition-merge transform**,
except for the one measure that cannot be summed.

- A per-stage `QuadTransform` (`mergeNamespaceVariants`) buffers a stage’s
  VoID output, re-mints every partition IRI from its **canonical** key
  components (replicating the queries’ `MD5(CONCAT(STR(…)))`), collapses the
  duplicate partition nodes, and **sums** `void:entities` / `void:triples`.
  The class selector canonicalizes and de-duplicates its bindings and the
  reader expands each canonical class back to its namespace variants, so a
  class’s variants are co-located in one batch — the merge is therefore
  self-contained per stage.
- The `void-ext` queries (`datatype`, `object-class`, `language`) emit their
  parent `cp → pp` chain (`void:class`, `void:property`) so the transform can
  re-key them from an otherwise opaque hash.
- `class-properties-objects.rq` keeps query-time normalization: its
  `void:distinctObjects` is a distinct-count over object _values_, which
  overlap across namespace variants even when subjects are disjoint, so
  summing would over-count. It is deduped in the query and never reaches the
  transform.

### Assumptions of record

Summing pre-aggregated counts is exact only under:

- **Subject/class disjointness** — no resource is typed under two namespace
  variants of the same class. Guards the class-partition `void:entities` sum
  and every `void:triples` sum.
- **Predicate-namespace disjointness** — no subject uses two namespace
  variants of the same property. Guards the property-partition
  `void:entities` sum.

Both hold in practice for the schema.org datasets that motivate this (the
variants appear as disjoint subsets of the data). A resource typed under
both variants over-counts its class entities; this is pinned by a test and
documented on the transform.

## Consequences

- The six analysis queries return to plain, index-friendly SPARQL (only
  `class-properties-objects.rq` normalizes, because it must).
- Normalization lives in one unit-tested transform, applied uniformly to
  dump-loaded and remote-endpoint datasets alike — no dependence on being
  able to rewrite the source.
- The correctness of the summed measures is now assumption-bound rather than
  exact; the assumptions are documented and the known violation is tested.
- `namespaceAliases` is a stage option; with none configured the transform
  is a no-op and the behaviour is unchanged.
