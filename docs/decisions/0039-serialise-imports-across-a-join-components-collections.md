# 39. Serialise imports across a join component’s collections

Date: 2026-11-14

## Status

Accepted

Amends [ADR 19 (Filter across collections through declared joins)](./0019-filter-across-collections-through-declared-joins.md):
its first documented limitation, that a component built from scratch needs two
indexing runs, no longer holds.

## Context

Typesense 30.2 permanently loses some `async_reference` values written while
the referenced collection is being imported at the same time. Sequential
imports are exact in either order: a reference written before its referent
exists resolves the moment the referent lands. ADR 19 worked around the loss by
running the indexer twice on a first build, because a second run meets
referents that already exist.

That fails with `REBUILD_MODE=blue-green`, which builds fresh collections on
every run, so every run is a first build. Linked Open Limburg runs blue/green.

No Typesense release after 30.2 fixes it (31.0 was at rc25 on 2026-11-10), and
no issue in typesense/typesense reports it.

The overlap comes from two places. Per-type stages fill import batches while
they run, and the pipeline flushes a dataset by landing every collection’s
remainder at once. The joins end-to-end test in `@lde/search-pipeline`
reproduces it on every run: with 900 datasets imported partly during their
stage and partly at the flush, alongside the publishers they reference, only
the 600 datasets imported before the flush joined to their publisher.

## Decision

Every batch import into a collection goes through a lock shared by its join
component:

- any number of imports into the **same** collection run at once;
- an import into one collection of a component waits until no import into
  **another** collection of that component is in flight;
- waiters are admitted in arrival order, and every waiter of the admitted
  collection goes in together, so a collection that keeps importing cannot
  starve another in its component.

The lock lives in `@lde/search-typesense`, around the one function that sends
an import (upsert or update) to Typesense. A writer looks it up from the join
component of the schema it was given, so the writers of a component share it
as long as they are given the same `SearchSchema` – which `searchIndexWriter`
always does. No option, no new interface: a workaround for an engine bug
stays in the engine adapter.

A type with no joinable reference is a component of one, so its imports never
wait. `CreativeWork` batches from different datasets still run in parallel.

The lock is released when Typesense answers the import, so it only works if
the engine has finished back-filling by then. The joins end-to-end test pins
that: after each import into a referenced collection, before the lock lets the
next import into another collection start, every document pointing at the
just-imported referents must already join to them.

### Alternatives considered

- **Lock in `searchIndexWriter`.** The router is engine-agnostic and sees a
  stream of documents per type, not the batches the engine writer cuts it
  into, so it cannot tell when an import is in flight. Locking a whole
  `write` per type would also deadlock a write call that feeds two collections
  of one component.
- **Order the imports: all datasets before any work.** Holding the works back
  until every dataset has landed buffers documents in proportion to the input,
  which [ADR 12](./0012-bound-memory-by-the-unit-of-work-not-the-input.md) rules
  out. The lock keeps memory bounded by one batch per type.
- **A library lock.** None of the locks already in the dependency tree
  (`async-lock` is a keyed mutex) or common on npm (readers-writer locks such as
  `@esfx/async-readerwriterlock`) gives concurrency within a group and
  exclusion between any number of groups. A readers-writer lock fits a
  component of two collections only by making one of them exclusive with
  itself. The local lock is about 50 lines.
- **Keep running the indexer twice.** It fails blue/green on every run.

## Consequences

- One indexing run resolves every join, in-place and blue/green. The “run the
  indexer twice” advice is gone from the `@lde/search-typesense` docs.
- Imports into a component’s collections no longer overlap, so a component
  imports a little more slowly. For Linked Open Limburg we expect the cost to be
  small: `Dataset` and `Publisher` take one document per dataset, so each of
  their imports waits for at most the works batches in flight, then holds the
  works back for the length of one small import. This still has to be measured
  on a timed run.
- The lock is per process. Two indexer processes writing the same component at
  once are not serialised against each other; the cross-pod rebuild lock
  already keeps a second run of the same collection from starting.
- Re-test on every Typesense upgrade. When the engine stops losing references,
  the lock can go.
