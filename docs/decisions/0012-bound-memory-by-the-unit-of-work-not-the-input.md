# 12. Bound memory by the unit of work, not the input

Date: 2026-07-16

## Status

Proposed

Underpins [ADR 11 (Decouple RDF depth from the API surface)](./0011-decouple-rdf-depth-from-the-api-surface.md)
and [#606](https://github.com/ldelements/lde/issues/606), both of which depend on
this invariant without stating it.

**Partly supersedes
[ADR 9 (Route a whole-schema projection to per-type collections)](./0009-route-a-whole-schema-projection-to-per-type-collections.md)** –
its whole-schema single-scan mixed stream and its buffer-until-flush, both sized
by the input. [ADR 9](./0009-route-a-whole-schema-projection-to-per-type-collections.md)’s fan-out placement and its per-document `searchType` are
untouched and still current;
[ADR 13](./0013-project-inside-the-batch-per-root-type.md) works out what
replaces the mechanism.

## Context

LDE processes data it cannot hold. The Dataset Register’s catalog is a few
hundred megabytes of dataset _descriptions_; a single registered dataset’s
_contents_ are millions of objects. A library that must be told how much data it
is about to see is not usable for the second case.

**This is not a new rule. It is an invariant most of the workspace already obeys,
which nothing states – so nothing enforces it.** Six packages converged on it
independently, each inventing its own name:

- `@lde/pipeline` – `AsyncQueue` is a bounded, back-pressured channel
  (`capacity`); `Stage` reads one `batchSize` of selector bindings at a time,
  with `maxConcurrency` batches in flight; `SparqlSelector` paginates under
  `maxResults`.
- `@lde/search-typesense` – `BatchImporter` holds one `batchSize` of documents.
- `@lde/distribution-probe` – shipped as _“bounded-stream reads”_ (`aabcd08`).
- `@lde/pipeline-shacl-sampler` – sampling is bounding.

One package did not, and there was nothing to point at:
`@lde/search-pipeline`’s `searchIndexWriter` accumulates a whole dataset’s quads
and then every projected document. It has honestly declared its bound in a JSDoc
since its first commit – _“Memory is bounded by one dataset’s extraction”_ – and
that sentence went unchallenged through review, an epic and an ADR.

Two things made it invisible, and the decision below targets both.

**“Streaming” is not the invariant.** `searchIndexWriter` _is_ streaming: it
consumes an `AsyncIterable<Quad>`, yields an `AsyncIterable<Document>`, and never
blocks the queue. It would pass a “must be fully streaming” rule and is still
O(input). Worse, the rule cannot be honestly obeyed everywhere: projection cannot
be quad-streaming, because a document needs a root’s **complete** quads. Grouping
is forced, not a compromise.

**A bound stated in the data’s own units is not a bound.** “One dataset’s
extraction” is true, and useless: for the catalog grain a dataset is a ~15-quad
description, for the object grain it is the entire input. Same sentence, same
code, and the bound evaporated when the _unit_ changed meaning underneath it.

## Decision

**Memory is bounded by the unit of work, never by the size of the input.**

- **A bound must be independent of the input.** “One dataset”, “one
  distribution”, “one graph”, “one run” are inputs wearing a bound’s clothes. If
  the only way to shrink a structure is to be handed less data, it is not
  bounded.

- **Tunability is a second property, not this one.** `batchSize` and
  `maxResults` are configured by the operator; `AsyncQueue`’s `capacity` is a
  fixed 128, never passed at either call site (`stage.ts:273`,
  `pipeline.ts:348`) – **still a bound**, because a constant does not track the
  input, but not one anyone can trade against throughput. Configure a bound where
  the cost per item varies by deployment: 128 quads is tens of kilobytes, 128
  documents is orders of magnitude more. A fixed constant satisfies this ADR; an
  unconfigurable one may still be the wrong size.

- **The atom is one root’s quads** – data-defined and irreducible, because a
  document needs its root’s complete quads. Every bound here is expressed in
  whole roots; a single pathological root is unbounded and nothing removes that
  floor.

- **Bounded is not the same as streaming.** A step may be _grouped_ – projection
  takes a batch and emits its documents – provided the group is the configured
  unit. Per-quad streaming is one way to satisfy this rule, not the rule.

- **No data-sized structure outlives its unit.** No `Set` over every quad, no
  array of every document, no `jsonld.frame()` over a graph, no index built from
  a whole input. Whatever a unit allocates is released when the unit completes.

- **Every read or write path states its bound and tests it – by counting, not
  measuring.** A bound in a JSDoc is not a bound: that is the thing this ADR
  exists because we tried. Run the same path at two input sizes an order of
  magnitude apart and assert the peak live item count is **identical at both**.
  That is an assertion about a bound, and it fails deterministically the moment a
  structure grows with input. A `process.memoryUsage()` assertion is both flakier
  and _weaker_ – GC timing can hide a leak that a count cannot.

## Consequences

- **It costs round-trips, and that is the trade.** Bounded extraction means
  per-type × per-batch queries instead of one scan. `batchSize` is the dial:
  high where the input is small (the catalog), low where it is not (objects).

- **It forecloses whole-input optimizations, permanently.** [ADR 9](./0009-route-a-whole-schema-projection-to-per-type-collections.md)’s whole-schema
  single-scan projection, whole-graph framing, and one-pass deduplication across
  a run are each cheaper than the bounded version and each unavailable. Proposals
  to reintroduce them should be read as proposals to reintroduce an unbounded
  structure.

- **Unbounded is occasionally right, and must be argued.** A scalar aggregate
  (`SELECT (COUNT(*) AS ?n)`), a schema, a configuration, a selector’s page: all
  fixed or small by construction. The rule targets structures that grow with the
  data, not every allocation.

- **Cross-cutting bounds need an owner _per path_.** `deduplicateQuads`
  (`reader.ts:394`) and `buildSubjectIndex`’s `seen` (`frame-by-type.ts:45`) each
  keep a `Set<string>` for the same reason – QLever does not deduplicate
  CONSTRUCT output – but they are **not interchangeable**: `deduplicateQuads` is
  scoped to one `read()` call, so one reader, one batch; `buildSubjectIndex` sees
  `readerOutputs.flat()`, the merged batch, and is the only one that catches
  cross-reader duplicates. So: `buildSubjectIndex` owns it on the projecting path
  (readers set `deduplicate: false`); the reader owns it where no subject index
  exists. “Each roughly a textual copy of the graph” is true of `deduplicateQuads`
  only on an **unbounded** global stage – which is the catalog today, and what
  #606 fixes.

- **Known violations:** `searchIndexWriter` (#606) – the forcing function for
  writing this down – and `RunContext.selectedSources()` (`pipeline.ts:464-471`),
  which accumulates one IRI per selected dataset for the whole run.
  `InPlaceRebuild.commit` needs it for the membership sweep, and #534 requires
  it, so it is _arguably_ right at ~100 bytes × N datasets. But this ADR’s own
  rule is that unbounded must be **argued**, and it has not been.
