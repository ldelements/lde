# 2. Unify pipeline extension on quad transforms

Date: 2026-06-08

## Status

Accepted

## Context

Refines the extension model of [ADR 1](0001-merge-pipeline-approaches.md) and
supersedes the design conclusion in
[#434](https://github.com/ldelements/lde/issues/434) (the original
executor-decorator seam).

A pipeline run is an RDF dataflow:

```
select datasets → [per dataset] resolve distribution
   → [per stage] select items → run executors → merge → (validate)
   → [pipeline] transform → write
```

RDF is the pipeline’s interchange contract – its narrow waist: many kinds of
producer above, many kinds of consumer below, one quad type between them. Every
producer (`Executor`) emits `AsyncIterable<Quad>`; every consumer (`Writer`,
`Validator`, plugins) accepts them. A producer may read non-RDF input (e.g. future
[#18](https://github.com/ldelements/lde/issues/18)), but its output is always RDF.

Extending a pipeline is always the same operation – intercept the quad stream,
`AsyncIterable<Quad> → AsyncIterable<Quad>`, at one of those arrows. Only the
**where** and the **context** in scope differ.

The codebase already encodes that operation two ways:

- **`PipelinePlugin.beforeStageWrite`** (a `QuadTransform`) – once, on the aggregated
  pre-write stream.
- **Executor decoration** – the `deduplicate` option and the `UriSpaceExecutor` /
  `VocabularyExecutor` classes, whose `execute()` bodies just delegate to inner and
  transform the output.

Today such a decorating executor is a class holding the inner executor; it delegates,
propagates `NotSupported`, then transforms the output (recorded here as the pattern
this ADR moves away from):

```typescript
class VocabularyExecutor implements Executor {
  constructor(
    private readonly inner: Executor,
    private readonly vocabularies = defaultVocabularies,
  ) {}

  async execute(
    dataset: Dataset,
    distribution: Distribution,
    options?: ExecuteOptions,
  ): Promise<AsyncIterable<Quad> | NotSupported> {
    const result = await this.inner.execute(dataset, distribution, options);
    if (result instanceof NotSupported) return result;
    return withVocabularies(result, dataset.iri.toString(), this.vocabularies);
  }
}
```

Per-stage extension, the case behind
[#434](https://github.com/ldelements/lde/issues/434), has no encoding yet. The
obvious move, prototyped in [#435](https://github.com/ldelements/lde/pull/435), is a
generic executor decorator (`(inner: Executor) => Executor`, routed per stage). This
ADR rejects it:

- **Shallow module.** The type, helper, and option chain add surface for what
  `Executor` already provides: wrapping is just implementing `Executor` with an
  `inner` field.
- **Leaks a mechanical boundary.** A decorator wraps one `execute()` call – for a
  per-class stage, one _batch_ – so its aggregation window depends on `batchSize` and
  concurrency, internal knobs with no domain meaning. Contracts should sit on semantic
  boundaries (an executor’s complete output), not mechanical ones.

ADR 1’s “composition via decoration: executors wrap other executors” stays
as a mechanism but stops being a public surface: executors are composed with quad
transforms attached as data, not wrapped through a public decorator type.

## Decision

Model all pipeline extension as one shape – a quad transform carrying the context of
its extension point – with exactly two points.

```typescript
type QuadTransform<Ctx> = (
  quads: AsyncIterable<Quad>,
  context: Ctx,
) => AsyncIterable<Quad>;
```

### Extension point 1 – per-executor output transform (pre-merge)

A transform attaches to an executor and decorates **that executor’s output**
(not its siblings’) before the stage merges executors. A global stage invokes
its executor once, so the transform sees the executor’s complete output; a
per-class stage invokes its executor once per batch – one class at
`batchSize: 1` – and the transform runs per invocation.

```typescript
interface ExecutorContext {
  dataset: Dataset;
  distribution: Distribution; // endpoint reach: the transform may fire its own queries
  stage: string; // stage identity
}

interface AttachedExecutor {
  executor: Executor;
  transform?: QuadTransform<ExecutorContext> | QuadTransform<ExecutorContext>[];
}

type StageExecutors =
  | Executor
  | AttachedExecutor
  | (Executor | AttachedExecutor)[];
```

The stage runner applies the transform(s) in order to each executor invocation’s
output (propagating `NotSupported` untouched), then merges siblings. This is the
home of `withUriSpaces`, `withVocabularies`, and consumer post-processing like the
DKG subject-URI resolver – all global stages, where one invocation is the
executor’s whole output: per-executor targeting and a batch-independent window at
once. A per-class stage runs the transform per class (`batchSize: 1`), the domain
unit of per-class iteration; an aggregating transform on a per-class stage with
`batchSize > 1` would see a tuning-dependent window, so it should keep
`batchSize: 1` or stay per-quad.

### Extension point 2 – pre-write transform (post-merge, pipeline-wide)

`PipelinePlugin.beforeStageWrite`, unchanged: a `QuadTransform<{ dataset: Dataset }>`
over the merged, post-stage stream. The home of cross-cutting concerns – provenance,
namespace normalisation – that apply regardless of which executor produced a quad.

### What changes

- Wrapping an executor becomes data – `{ executor, transform }` – applied by one private
  stage-runner helper, the only code that touches `inner` and never exported. Composing a
  built-in transform with a consumer’s is just “apply in order” (the array), the fold the
  pipeline already uses for `beforeStageWrite`.
- The `UriSpaceExecutor` / `VocabularyExecutor` classes become the transforms they already
  wrap (`withUriSpaces`, `withVocabularies`), attached to their stage’s executor.
- `voidStages` gains a `transforms` map keyed by `VOID_STAGE_NAMES`, routing each consumer
  transform onto that stage’s executor – so a consumer decorates executors it never
  constructs. Each VoID stage has one executor, so per-executor attachment and per-stage
  routing coincide today and stay correct if a stage gains a second executor.

### Invariants

- **Contracts sit on semantic boundaries** – never a mechanical batch. For a
  global stage that boundary is the executor’s complete output; for a per-class
  stage it is one class (`batchSize: 1`), the domain unit of per-class iteration.
  Sibling merging and the post-merge stream stay batch-independent.
- **RDF is the interchange contract** – non-RDF ingestion lives inside an executor; the
  transform layer is `Quad`-typed, never generic over source formats.

## Consequences

- One concept covers all extension: a quad transform at two extension points.
  Authors write a function, not a class: no `implements Executor`, no `NotSupported` handling, no
  `inner` delegation. The only public additions are `QuadTransform`, `ExecutorContext`, and
  the `AttachedExecutor` attachment; no decorator type or composition helper enters the API.
- [#435](https://github.com/ldelements/lde/pull/435), which prototyped the decorator seam,
  is withdrawn; the DKG consumer ([#316](https://github.com/ldelements/lde/issues/316))
  attaches a transform instead of subclassing `Executor`.
- Migration touches `Stage` / `StageOptions` (accept `AttachedExecutor`, apply transforms
  before the merge), the two `@lde/pipeline-void` executor classes, the `voidStages`
  routing, and both package READMEs.
