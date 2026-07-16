# 12. Bound memory by the unit of work, not the input

Date: 2026-07-16

## Status

Proposed

Underpins [ADR 11 (Decouple RDF depth from the API surface)](./0011-decouple-rdf-depth-from-the-api-surface.md)
and [#606](https://github.com/ldelements/lde/issues/606), both of which depend on
this invariant without stating it.

**Partly supersedes
[ADR 9 (Route a whole-schema projection to per-type collections)](./0009-route-a-whole-schema-projection-to-per-type-collections.md)** –
its projection mechanism (the whole-schema single-scan mixed stream, the
per-document type tag, the buffer-until-flush), each of which is sized by the
input. ADR 9’s fan-out placement is untouched and still current.

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

**Memory is bounded by a configured unit of work, never by the size of the
input.**

- **A bound must name a unit the operator configures, not one the data defines.**
  `batchSize`, `capacity`, `maxResults` are bounds. “One dataset”, “one
  distribution”, “one graph”, “one run” are inputs wearing a bound’s clothes.
  If the only way to shrink a structure is to be handed less data, it is not
  bounded.

- **Bounded is not the same as streaming.** A step may be _grouped_ – projection
  takes a batch and emits its documents – provided the group is the configured
  unit. Per-quad streaming is one way to satisfy this rule, not the rule.

- **No data-sized structure outlives its unit.** No `Set` over every quad, no
  array of every document, no `jsonld.frame()` over a graph, no index built from
  a whole input. Whatever a unit allocates is released when the unit completes.

- **Every read or write path states its bound and tests it.** A bound in a JSDoc
  is not a bound – it is the thing this ADR exists because we tried. The test
  asserts memory stays flat as input grows, which is the only form that fails
  when the claim quietly stops being true.

## Consequences

- **It costs round-trips, and that is the trade.** Bounded extraction means
  per-type × per-batch queries instead of one scan. `batchSize` is the dial:
  high where the input is small (the catalog), low where it is not (objects).

- **It forecloses whole-input optimizations, permanently.** ADR 9’s whole-schema
  single-scan projection, whole-graph framing, and one-pass deduplication across
  a run are each cheaper than the bounded version and each unavailable. Proposals
  to reintroduce them should be read as proposals to reintroduce an unbounded
  structure.

- **Unbounded is occasionally right, and must be argued.** A scalar aggregate
  (`SELECT (COUNT(*) AS ?n)`), a schema, a configuration, a selector’s page: all
  fixed or small by construction. The rule targets structures that grow with the
  data, not every allocation.

- **Cross-cutting bounds need an owner.** `deduplicateQuads` and
  `buildSubjectIndex` independently keep a `Set<string>` over the same content –
  each roughly a textual copy of the graph – for the same reason (QLever does not
  deduplicate CONSTRUCT output). Two enforcements of one quirk cost two copies.
  When a bound is everyone’s job it is paid for twice.

- **Known violation:** `searchIndexWriter` (#606), which is the forcing function
  for writing this down.
