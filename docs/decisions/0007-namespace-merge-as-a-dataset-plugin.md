# 7. Normalize namespace variants in a per-dataset plugin

Date: 2026-07-08

## Status

Accepted

Extends the plugin model of
[ADR 2 (Unify pipeline extension on quad transforms)](./0002-unify-pipeline-extension-on-quad-transforms.md)
and the writer run model of
[ADR 6 (Make the Writer transaction-aware)](./0006-make-the-writer-transaction-aware.md).

## Context

A dataset that describes the same class under both `http://schema.org/` and
`https://schema.org/` yields two VoID `void:classPartition` nodes for what is
conceptually one class, double-counting it in every roll-up. We want a single,
canonical partition per class.

A first iteration solved this _inside_ the VoID core: a per-stage transform
plus a class selector that canonicalized and co-located the namespace variants
per batch, backed by query-level markers and self-describing `void-ext` chains.
That worked, but it threaded namespace-alias awareness through the analysis
queries and the stage machinery — the core was no longer agnostic to a
consumer-specific concern.

Two facts reframe the problem:

- Merging per-class partitions needs the `http`/`https` variants of a class
  seen _together_. A per-stage hook (`beforeStageWrite`) only holds within one
  batch, which is what forced the selector co-location into the core.
- Datasets typically use a single schema.org namespace, so within one dataset
  there is one variant per class. The cross-variant merge — and the machinery
  for it — is for the rare mixed dataset, not the common case.

## Decision

Add a generic **`beforeDatasetWrite`** plugin hook to `@lde/pipeline` and move
namespace normalization into a plugin that uses it; keep the VoID core on
plain, alias-free queries.

- **`beforeDatasetWrite`** is a `QuadTransform` that runs once over a whole
  dataset's cross-stage output before it is written — the dataset-scoped
  sibling of `beforeStageWrite`. It is implemented as a `RunWriter` decorator
  that feeds every stage's write for a dataset through one `AsyncQueue` and
  hands that stream to the transform, so output is streamed, not materialized;
  it honors the `flush`/`reset`/`commit`/`abort` run lifecycle. The hook is
  domain-agnostic — dedup, roll-ups, or partition merging can use it.
- **`schemaOrgNormalizationPlugin`** (in `@lde/pipeline-void`) is a
  `beforeDatasetWrite` plugin that canonicalizes `void:class`/`void:property`
  objects and re-mints/merges partition IRIs from their canonical components.
  A whole-dataset view resolves each partition's `cp → pp → dp` chain from the
  other stages' output, so the queries need no self-describe chains and no
  markers.
- The six analysis queries are plain SPARQL; no selector, query markers or
  `void-ext` self-describe chains are needed in the core.
- Namespace rewriting splits by generality. `@lde/pipeline` keeps a generic,
  vocabulary-agnostic `namespaceNormalizationPlugin` (and its
  `schemaOrgNormalizationPlugin` wrapper) — a `beforeStageWrite` transform that
  rewrites a namespace's IRIs wherever they appear, for consumers that just need
  to standardize a namespace (e.g. mapping instance data to an application
  profile). `@lde/pipeline-void` owns the VoID-specific piece,
  `schemaOrgPartitionMergePlugin`, which additionally re-keys and merges the
  partition nodes — the part that needs VoID structure and the shared
  partition-IRI minting.

### Assumptions

Single-namespace datasets (the common case) have one variant per class, so the
plugin only renames and re-keys — every count, including `void:distinctObjects`,
stays exact. A dataset that genuinely mixes both namespaces on the same class
collapses the variants by summing measures; `void:distinctObjects` then
over-counts shared objects. This is documented and not optimized for.

## Consequences

- The VoID core is agnostic to namespace aliases — normalization is one
  opt-in plugin at the pipeline edge, which is where it belongs.
- `@lde/pipeline` gains a reusable per-dataset extension point.
- Memory stays bounded by the summary: the merge buffers only partition quads;
  everything else streams through.
- Consumers configure it as `plugins: [schemaOrgNormalizationPlugin(), …]`
  rather than threading `namespaceAliases` through `voidStages`.
- The partition-IRI scheme lives in one module (`partitionIri.ts`): the
  transform mints in TypeScript and the queries' SPARQL minting is generated
  from the same source (`#mint:<kind>#` markers), so the two cannot silently
  diverge.
- A per-dataset writer failure is isolated to that dataset (recorded failed,
  retried next run) rather than aborting the run — the whole-dataset write is
  deferred, so its failure surfaces at flush, which the pipeline now catches
  per dataset.
