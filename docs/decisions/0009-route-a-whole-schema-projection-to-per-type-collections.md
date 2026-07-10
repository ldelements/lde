# 9. Route a whole-schema projection to per-type collections

Date: 2026-07-10

## Status

Accepted

Extends the writer model of
[ADR 6 (Make the Writer transaction-aware)](./0006-make-the-writer-transaction-aware.md)
and the reference model of
[ADR 8 (Resolve reference labels from per-reference label sources)](./0008-resolve-reference-labels-from-per-reference-label-sources.md);
updates the catalog grain of search as a Configurable Pipeline instance
([#534](https://github.com/ldelements/lde/issues/534)) from one collection to
several ([#590](https://github.com/ldelements/lde/issues/590)).

## Context

One validated `SearchSchema` declares several root types. The Dataset Register
indexes four: `datasets` plus the Organization / Class / TerminologySource label
collections its references resolve against (ADR 8). Each type derives its own
Typesense collection schema, so the types cannot share a collection – they are
four independent blue/green rebuilds, each with its own versioned collection,
alias and single-flight lock.

ADR 6 made the engine `Writer` a transactional, **single-collection** rebuild
(`BlueGreenRebuild` / `InPlaceRebuild`), bound to one `SearchType`. `projectGraph`
already projects the **whole** schema in one pass – a single scan of the quads
builds the subject index every type frames off – yielding one mixed stream of
documents. Nothing joined the two: a consumer that wanted several collections
had to forge a per-type schema brand, hand-roll a per-type rebuild loop and cast
a per-type projection. The per-collection fan-out had no home.

Two placement options: (a) a composition in `@lde/search-pipeline` over N
single-collection engine writers, or (b) a new multi-collection writer inside
`@lde/search-typesense`. (a) keeps the engine adapter a single-collection
concern and keeps the fan-out engine-agnostic (an OpenSearch adapter would reuse
it unchanged), so the routing is a pipeline-glue concern, not an engine one.

## Decision

- **The projection tags each document with its type.** `projectGraph` yields
  `{ searchType, document }` (`TypedSearchDocument`), not a bare `SearchDocument`.
  The whole schema still projects into one mixed, single-scan stream; the tag is
  what lets the write side route each document to the collection for its type
  without re-deriving the type from the document. A single-collection consumer
  just reads `document`.

- **`@lde/search-pipeline`’s `searchIndexWriter` fans out (option a).** It takes
  the schema and a `writerFor(searchType)` factory, builds one engine writer per
  root type once, and on each run opens one engine run per type. A dataset’s
  quads are buffered until its flush, projected once (whole schema), then split
  by type and dispatched to each type’s run. The pipeline still drives one
  uniform `openRun → write* → commit/abort` and never branches on the
  multi-collection shape – consistent with ADR 6’s single lifecycle. A
  single-collection deployment is just the N = 1 case.

- **Each collection commits, sweeps and fails in isolation.** A type whose
  projection is empty this run affects only its own collection, never another’s;
  the empty-selection guard ([#569](https://github.com/ldelements/lde/issues/569))
  is therefore per collection by construction, not a single global gate. `commit`
  finalizes every collection independently and, if any fails, throws an
  `AggregateError` _after_ attempting them all: a non-critical label-collection
  failure never blocks the collections that did commit – in particular the
  `datasets` index still goes live – while the failure is still surfaced, so a
  stale collection is never silent.

- **`abort` finalizes only the collections that did not go live.** The pipeline
  aborts a run whose `commit` throws (ADR 6), so a partial commit reaches
  `abort`. Because a committed blue/green rebuild’s `abort` would drop its
  now-live collection, `abort` skips the collections that already committed and
  drops only the half-built ones (and releases their locks). A failure while
  _opening_ the per-type runs rolls the already-opened ones back the same way.

## Consequences

- The Dataset Register consumer collapses: project the schema, hand the stream
  to `searchIndexWriter` with a `writerFor` that returns a `BlueGreenRebuild` per
  type. The forged schema brand, the per-type projection casts and the
  hand-rolled per-type rebuild loop all go away.

- Breaking for `@lde/search`: `projectGraph` yields `TypedSearchDocument`, not
  `SearchDocument`. Breaking for `@lde/search-pipeline`: `searchIndexWriter`
  takes `writerFor` (per type) instead of a single `writer`.

- The partial-failure policy is fail-the-run-but-commit-what-can: the safest
  default (no silent staleness) that still honours the isolation requirement. A
  skip-and-report or critical/non-critical-per-type policy can layer on later
  without changing the routing, if a deployment needs the `datasets` index to go
  live without the run being marked failed.

- The fan-out is engine-agnostic: it composes any transactional
  `Writer<SearchDocument>`, so a second engine adapter reuses it unchanged.
