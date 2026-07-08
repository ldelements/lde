# 8. Normalize namespace variants in a per-dataset plugin

Date: 2026-07-08

## Status

Proposed

Supersedes the mechanism (not the goal) of
[ADR 7 (Merge namespace-alias VoID partitions after aggregation)](./0007-merge-namespace-alias-partitions.md).
Extends the plugin model of
[ADR 2 (Unify pipeline extension on quad transforms)](./0002-unify-pipeline-extension-on-quad-transforms.md)
and the writer run model of
[ADR 6 (Make the Writer transaction-aware)](./0006-make-the-writer-transaction-aware.md).

## Context

ADR 7 merged `http`/`https` schema.org VoID partitions, but did it _inside_
the VoID core: a per-stage transform plus a class selector that
canonicalized and co-located namespace variants per batch, plus query-level
markers and self-describing `void-ext` chains. That threaded namespace-alias
awareness through the analysis queries and the stage machinery — the core was
no longer agnostic to a consumer-specific concern.

Two facts reframe the problem:

- Merging per-class partitions needs the `http`/`https` variants of a class
  seen _together_. Per-stage (`beforeStageWrite`) that only holds within one
  batch, which is what forced the selector co-location into the core.
- Datasets typically use a single schema.org namespace, so within one dataset
  there is one variant per class. The cross-variant merge — and the machinery
  for it — is for the rare mixed dataset, not the common case.

## Decision

Add a generic **`beforeDatasetWrite`** plugin hook to `@lde/pipeline` and move
namespace normalization into a plugin that uses it; revert the VoID core to
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
- The six analysis queries revert to plain SPARQL; the selector, query
  markers and `void-ext` self-describe chains added in ADR 7 are removed. The
  superseded object-only `schemaOrgNormalizationPlugin`/`namespaceNormalizationPlugin`
  in `@lde/pipeline` are removed.

### Assumptions

Single-namespace datasets (the common case) have one variant per class, so the
plugin only renames and re-keys — every count, including `void:distinctObjects`,
stays exact. A dataset that genuinely mixes both namespaces on the same class
collapses the variants by summing measures; `void:distinctObjects` then
over-counts shared objects. This is documented and not optimized for.

## Consequences

- The VoID core is agnostic to namespace aliases again — normalization is one
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
