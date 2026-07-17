# 13. Project inside the batch, per root type

Date: 2026-07-17

## Status

Proposed

Applies [ADR 12 (Bound memory by the unit of work, not the input)](./0012-bound-memory-by-the-unit-of-work-not-the-input.md)
to the search projection. Amends
[ADR 2](./0002-unify-pipeline-extension-on-quad-transforms.md); supersedes gap 1
of [#579](https://github.com/ldelements/lde/issues/579).
[ADR 9](./0009-route-a-whole-schema-projection-to-per-type-collections.md)’s
fan-out is **untouched** – only the buffering [ADR 12](./0012-bound-memory-by-the-unit-of-work-not-the-input.md) already superseded goes.
Implemented by [#606](https://github.com/ldelements/lde/issues/606).

## Context

`searchIndexWriter` buffers every quad of a dataset, then every projected
document – [ADR 12](./0012-bound-memory-by-the-unit-of-work-not-the-input.md)’s known violation, and why object indexing is impossible. It
buffers for a real reason: projection needs a root’s **complete** quads, and a
flat `AsyncIterable<Quad>` carries no completion signal.

The root-complete group already exists. `stage.ts:340`’s `batchQuads` is one per
in-flight batch, bounded by `batchSize × maxConcurrency`, and is then destroyed
quad-by-quad at `queue.push`. Nothing needs recovering; it is thrown away one
layer above the step that needs it.

Two prior decisions block the obvious fix. Neither survives the code:

- **#579** ruled per-type projection out: _“a projection always operates over a
  resolvable whole.”_ The projection resolves nothing – `applyFacet`
  (`project.ts:206-220`) stores bare IRIs, and `labelSource` occurs only in
  declaration-time validation (`schema.ts:346`) and the query-time engine
  (`search.ts:156`). The guarantee binds the **port**, not the projection
  ([ADR 8](./0008-resolve-reference-labels-from-per-reference-label-sources.md)).
  #579 was right that the **forge** (`as unknown as SearchSchema`) must die –
  it bypasses the only validating constructor – but went from _the cast is bad_
  to _the primitive is bad_.
- **[ADR 2](./0002-unify-pipeline-extension-on-quad-transforms.md)** forbids a contract on a mechanical batch, because _“its aggregation
  window depends on `batchSize`.”_ Under a **root-bound** selector the window is
  a whole number of complete roots: `batchSize` moves memory and request count,
  never output.

Two constraints then fix the shape, and they converge from different premises:

- **Writing happens at the end.** `source → transform → sink`; #534 makes the
  `Writer` the pipeline’s single transaction-aware terminal. A `Writer` per stage
  would make every stage a terminal – N pipelines wearing one name.
- **Imports must not be duplicated.** `pipeline.ts:569` resolves each dataset’s
  distribution _inside the per-dataset loop_, and with an `ImportResolver` that
  means download + QLever index + server start (`importResolver.ts:195`).
  Indexing is slow and the importer caches **one** index, so a pipeline per root
  type re-imports every dataset N times with zero cache hits. Sharing the import
  requires sharing the dataset loop – which is one pipeline.

So: **one pipeline, N stages, one terminal.**

## Decision

**Project inside the batch, per root type, over the roots the selector
supplied.**

- **One seam.** `Stage<Out = Quad>` gains
  `project?: (quads, ctx) => Iterable<Out>`, applied to the root-complete batch.
  It requires `itemSelector` – no selector means no batch, and the only
  remaining group is the readers’ whole output, an input-sized unit [ADR 12](./0012-bound-memory-by-the-unit-of-work-not-the-input.md)
  forbids by name. It is the pipeline’s **only** type-changing extension point.
  `Out = Quad` is the default, so every pipeline that does not project is
  unchanged.

- **The write-side plugins have no quads to touch, so a projecting pipeline has
  none.** `beforeStageWrite` and `beforeDatasetWrite` are `QuadTransform`s
  (`AsyncIterable<Quad> → AsyncIterable<Quad>`), and they run _after_ the stage
  output – where a projecting pipeline’s data is already `SearchDocument`. There
  is nothing for a quad transform to bite on; the exclusion is a semantic fact,
  not a type convenience. (`beforeStageWrite` is also displaced outright:
  `provenanceTransform` (`plugin/provenance.ts:24-32`) is a tail aggregator that
  wants the last post-merge slot, and projection took it, because projection
  needs the group.) The current plugins confirm it – provenance, namespace
  normalization, cross-stage dedup are all RDF operations, and a projecting
  pipeline’s product is a search index, not a graph. Because the constraint is on
  the plugin’s _input type_, it is a **compile error**, not a runtime guard:
  `plugins?: [Out] extends [Quad] ? PipelinePlugin[] : never`, so a projecting
  pipeline cannot even name `plugins`. **Reader-attached `QuadTransform`s are
  unaffected** ([ADR 2](./0002-unify-pipeline-extension-on-quad-transforms.md)):
  they run on the reader output, _before_ the seam, where quads still exist. The
  `never` is _“no quad plugins here”_, not _“no plugins here”_: a write-side
  **document** transform is a clean additive extension (widen the conditional to
  a `DocumentTransform` branch) if a need appears – but none does today, since
  the obvious candidate, cross-dataset URI dedup, is deferred to query-time
  grouping (#534). Deferred as YAGNI.

- **No automated `rdf:type` handling – the selector owns it.** The projection is
  handed its batch’s roots rather than scanning the extracted quads to discover
  them, so `projectRoots(quads, roots, schema, searchType)` replaces
  `projectGraph(quads, schema)`; `rootsByType` and `frameByType` go, and
  `frameSubjects` frames by `@id` – all it ever really did.
  `assertTypeInSchema` – the port’s own guard – enforces membership, so no schema
  is ever forged. The selector may well ask for `?x a <class>`; that is its
  business. The Dataset Register’s **injected** `rdf:type` triples and its
  **minted** `a dcat:Dataset` exist only to feed the discovery, and both stop
  being necessary.

- **One stage per root type**, with its own selector and extraction. Forced
  twice: a stage hands its bindings to _every_ reader, and whole-schema
  projection over a per-type batch emits a spurious half-populated document the
  moment a referent carries a type – which is the modelling #579 itself
  recommends.

- **`selectByClass(searchType)` is a helper, not a default.** Root selection is
  a deployment concern; `SearchType.class` is the IR/API class, and three of the
  Dataset Register’s four types have no source class at all. Where the two
  coincide (SCHEMA-AP objects) the deployment says so in one word.

- **One terminal, at the end.** All stages write to the pipeline’s `Writer`.
  `searchIndexWriter` stays exactly what [ADR 9](./0009-route-a-whole-schema-projection-to-per-type-collections.md) made it – the engine-agnostic
  per-collection fan-out – and **stops projecting and stops buffering**. A
  `Writer` per stage is rejected: it breaks `source → transform → sink`, and the
  N run lifecycles it needs are pure cost.

- **`SearchDocument` carries its `SearchType`.** N stages write to one terminal
  and `write(dataset, items)` has no stage identity, so the type travels with
  the item. A stage mints the pair itself – it was constructed for one type.
  `TypedSearchDocument` **moves to `@lde/search-pipeline`**: it exists only
  because a pipeline terminal routes, which is glue, not projection.
  `@lde/search` yields a bare `SearchDocument` and stays pipeline-free.

## Consequences

- **Memory is bounded by `batchSize` roots** at every structure on the path. The
  atom is **one root’s quads**: irreducible, data-defined, and unbounded for a
  pathological root. Nothing here fixes that; say it out loud rather than hide
  it inside the bound.

- **`Pipeline<Out = Quad>` becomes generic**, but narrowly: `PipelineOptions`’
  `stages`/`writers`, `FanOutWriter`/`FanOutRunWriter`, `stageWriter`,
  `runStages`/`runStage`, `runChain` and `collectStages`. The `QuadTransform`
  surface – both plugin points and the two writers wrapping them –
  **stays `Quad`**. That the surface _can_ stay `Quad` is a runtime fact tsc
  cannot see (a projecting pipeline never reaches it), so the boundary where a
  generic `RunWriter<Out>` meets a `Quad`-typed transform writer is bridged by a
  small number of unchecked casts (~8 in the spike). Not free, and not net-zero:
  measured at **+69 lines across the two files**, of which the `project` seam is
  ~20 and the rest is those casts, the generic threading, and their justifying
  comments. Confirmed against `tsc`: the whole workspace (27 projects) and every
  existing test compile unchanged under the `Out = Quad` default.

- **The type parameter earns its keep: a mixed pipeline is a compile error.**
  Verified – `stages: [Stage<Quad>, Stage<SearchDocument>]`, and a
  `Pipeline<SearchDocument>` handed a `Writer<Quad>`, are both rejected
  (`TS2322`). This holds despite `Out` appearing in a method parameter (checked
  bivariantly): bivariance only relaxes _subtype_ relationships, and `Quad` and a
  document are unrelated, so the check fails as if invariant. One rough edge –
  inference does not union candidates, so a mixed array with no writer to pin
  `Out` falls back to the default and points the error at the projecting stage
  rather than naming the mix. The rejection is sound; the diagnostic is imperfect.

- **`runChain` stays quad-only, as a runtime contract.** A chained stage
  serializes its output to N-Triples (`pipeline.ts:941-944`), which a
  `SearchDocument` cannot do – but “sub-stages imply `Out = Quad`” is not
  expressible, because `chaining` and `stages` are independent options. So it is
  a construction guard, not a type. (`project` and `stages` on the _same_ stage,
  by contrast, are mutually exclusive and _are_ typed.)

- **Stages stay sequential** (`pipeline.ts:823`), each already running
  `maxConcurrency` batches internally, and a stage’s failure is already isolated
  to that stage. Running stages in parallel is safe – [ADR 8](./0008-resolve-reference-labels-from-per-reference-label-sources.md) resolves labels at
  query time, so the label stages have no ordering dependency on the Dataset
  stage – but it multiplies both the load on the one shared endpoint and the
  memory bound. If it is ever wanted it is an additive, configured knob.

- **[ADR 2](./0002-unify-pipeline-extension-on-quad-transforms.md) is amended, not discarded.** Its two quad extension points,
  transforms-as-data, and _“non-RDF ingestion lives inside a reader”_ all stand.
  Superseded: _“RDF is the narrow waist”_ – RDF is the waist **from reader to
  batch**; a stage may declare one type-changing seam at the batch, and only
  there. Restated: _“never a mechanical batch”_ → **a contract’s window is
  always a whole number of complete roots.** ([ADR 2](./0002-unify-pipeline-extension-on-quad-transforms.md) also still says there are
  exactly two extension points; `beforeDatasetWrite` made that three before this
  ADR made it four.)

- **`RunWriter`’s JSDoc is corrected – not [ADR 6](./0006-make-the-writer-transaction-aware.md).** `writer.ts:59` claims a run
  is _“bracketed by exactly one `commit` or `abort`”_, and `writer.ts:95` that
  `commit` is _“called exactly once”_. Both are already false:
  `pipeline.ts:479-487` aborts a run whose `commit` throws. [ADR 6](./0006-make-the-writer-transaction-aware.md) itself says
  only that `Pipeline.run` drives `openRun → write* → commit/abort` uniformly,
  which is true and needs no amendment. A writer must tolerate `abort` after
  `commit`; `searchIndexWriter`’s `committed` set is why that works today.

- **[ADR 12](./0012-bound-memory-by-the-unit-of-work-not-the-input.md) is corrected in the same change**, by applying it here. Its rule read
  _“a bound must name a unit the operator configures, not one the data defines”_ –
  a false dichotomy: `AsyncQueue`’s `capacity = 128` is neither, and is a
  perfectly good bound, because a constant does not track the input. The
  invariant is **independence from the input**; configurability is a separate
  property, worth having where cost per item varies (128 quads vs 128 documents
  differ by orders of magnitude) but not the rule. It also gains the atom (one
  root’s quads), `selectedSources()` as a second known violation, the counting
  form of its test, and a corrected dedup consequence – `deduplicateQuads` and
  `buildSubjectIndex` are scoped differently and are not interchangeable.

- **Most selectors are generable; the residue is the entry point.** A **Label
  Source**’s roots are already determined by the schema – they are the values of
  the references that name it, so `Organization`’s roots are the objects of
  whatever path `Dataset.publisher` declares, and `TerminologySource`’s the
  objects of `Dataset.terminology_source`’s. `selectByClass` covers the object
  grain, where `class` really is the source class. What is **not** derivable is
  the **entry point** – the Dataset Register’s “registered, newest registration,
  and has a title” is a deployment fact no schema states. So the Register
  hand-writes **one** selector, not four, and the extraction generator
  ([#548](https://github.com/ldelements/lde/issues/548)) emits the rest: a
  generator that emits CONSTRUCTs but leaves their roots hand-written is half a
  win. (`Dataset.class` is a `derive` with no `path` today, so its Label Source’s
  roots only become derivable once
  [#607](https://github.com/ldelements/lde/issues/607) gives it one – one more
  thing that issue buys.)

- **The Dataset Register’s extraction becomes root-bound**, which is what the
  catalog needs to realise any of this, and its `rdf:type` injection and minted
  `a dcat:Dataset` become unnecessary. Separate change, separate repo.

- **Root-boundedness is a promise `@lde/pipeline` cannot check.** A selector
  that does not bind the CONSTRUCT’s subject yields a batch that is not
  root-complete, and projection will silently emit partial documents. It joins
  `expectsOutput` as a documented contract.
