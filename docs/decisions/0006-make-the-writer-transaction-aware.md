# 6. Make the Writer transaction-aware

Date: 2026-07-06

## Status

Proposed

Amends the pipeline model of
[ADR 1 (Merge pipeline approaches)](./0001-merge-pipeline-approaches.md) and
[ADR 2 (Unify pipeline extension on quad transforms)](./0002-unify-pipeline-extension-on-quad-transforms.md);
groundwork for search as a Configurable Pipeline instance
([#534](https://github.com/ldelements/lde/issues/534)).

## Context

The pipeline’s `Writer` was a per-dataset sink (`write`/`flush`/`reset`)
with no notion of a run. Run-level lifecycle had no home: a search index
rebuild needs an atomic alias swap after all datasets are written
(Blue/green Rebuild), an in-place object index needs a deletion sweep over
everything the run did not touch plus a registry-membership sweep
(In-place Rebuild), and both need a single-flight cross-pod lock. The
existing `@lde/search-typesense` `rebuild()` bundles load + swap + lock in
a one-shot function outside the pipeline; QLever bulk-load + dir-swap has
the same shape. Without a run boundary on the writer, each consumer
rebuilds that lifecycle bespoke, or the pipeline would have to branch on
the destination’s update mode.

The input unit was named `Executor`, which says nothing about its role.

## Decision

### Reader / Writer as the pipeline’s I/O pair

Rename `Executor` → `Reader` (and `execute()` → `read()`): a `Reader`
produces quads for a dataset from outside the pipeline – a SPARQL endpoint,
a dump, or a non-RDF facade. `Reader`/`Writer` map to the NDE Stack’s
conceptual `source`/`sink`; we use the more familiar I/O terms. Only the
input renames – `Writer`, `FileWriter` and `SparqlUpdateWriter` keep their
names.

### One run, one transaction

`Writer` becomes a factory of per-run transactions, generic over its
payload (`Writer<Item = Quad>` – KG writers stream quads unchanged; search
writers will consume pre-framed documents):

```typescript
interface Writer<Item = Quad> {
  openRun(context: RunContext): Promise<RunWriter<Item>>;
}
interface RunWriter<Item = Quad> extends DatasetWriter<Item> {
  // per-dataset finalize; outcome lets a writer gate destructive
  // finalization (an In-place stale-document sweep) on 'success'
  flush?(dataset: Dataset, outcome: DatasetOutcome): Promise<void>;
  reset?(dataset: Dataset): Promise<void>; // discard a dataset’s pass
  commit(): Promise<void>; // swap / sweep / release lock
  abort(error: unknown): Promise<void>; // leave the live destination as-was
}
```

`Pipeline.run` drives `openRun → write* → commit/abort` uniformly and
never branches on the writer’s update mode: an alias swap is a private
step of a Blue/green writer’s `commit()`, a sweep of an In-place writer’s.
Stages write through the narrower `DatasetWriter` (just `write`), so a
stage can never commit or abort the run.

### RunContext

`openRun` receives the run’s identity and selection scope: `runId` (stamps
`last_seen` for In-place, names the blue collection for Blue/green),
`startedAt` (injected – writers need no clock), `selectedSources()` (every
selected dataset IRI **including ones skipped as unchanged**, complete by
commit time – the input to a registry-membership sweep), and the
pipeline’s `provenance` store when skip-unchanged is enabled.

### One interface, no second path

A destination without run-level state implements the same contract with
no-op `commit`/`abort` (a five-line `openRun`; `SparqlUpdateWriter` shows
the pattern). There is deliberately **no** second `TransactionalWriter`
interface – it would reintroduce the dual code path the single contract
exists to remove – and no wrapper helper either: every in-repo destination
turned out to want real lifecycle behaviour, so a helper had no consumers
and was dropped for a minimal API surface.

## Consequences

- Breaking for `@lde/pipeline` consumers: `Executor` call sites rename, and
  custom writers implement `openRun` (with no-op `commit`/`abort` when they
  have no run-level state). The Dataset Knowledge Graph pipeline adapts on
  its next upgrade.
- `FileWriter` and `SparqlUpdateWriter` are transactional: per-run state
  (open files, cleared graphs) lives in the run, so re-running a pipeline
  on the same writer instance replaces output instead of appending –
  previously a latent bug. `FileWriter.commit` finalizes files still open;
  `abort` discards temp output, never leaving a truncated final file.
- Chained (sub-stage) scratch `FileWriter`s are now flushed before their
  output is resolved – previously the chain read a final path that only
  materialized on a flush nobody issued.
- The search writers (`BlueGreenRebuild`, `InPlaceRebuild` in
  `@lde/search-<engine>`) get a home for load + finalize as one atomic
  unit, replacing the one-shot `rebuild()`; the two update modes become
  `Writer` implementations, not pipeline branches.
