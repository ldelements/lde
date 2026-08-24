# 23. Resolve external references in a standalone library

Date: 2026-08-24

## Status

Accepted

Relates to [ADR 2](./0002-unify-pipeline-extension-on-quad-transforms.md) (the
quad transform is the seam this is called from),
[ADR 12](./0012-bound-memory-by-the-unit-of-work-not-the-input.md) (what bounds
the memory of a resolution) and
[ADR 16](./0016-ship-the-search-indexer-as-a-config-driven-image.md) (why LDE
owns no store, and therefore why the fact store is a seam).

## Context

Enrichment that draws on data **outside the graph** already has a place to run.
A `QuadTransform` attached to a reader sees the extraction CONSTRUCT’s output for
a batch of roots, can tell an absent value from a present one, and may mint IR
Aliases through the exported `irAlias()`. Contributing before projection is an
advantage rather than a workaround: the value is shaped by the schema like any
other, instead of the enricher re-implementing `physicalFields()` and its
per-locale companions.

What has no home is everything **around** the fetch. Every deployment that
writes such a transform re-solves the same five problems:

- a durable place for a resolved fact that survives an index rebuild – the
  indexer reads publisher RDF live per dataset, ADR 16 rules out an LDE-owned
  store, and a search index is rebuilt from its sources, so a fact fetched from
  outside has nowhere to live between runs;
- outbound work bounded, globally and per host;
- backoff and retry;
- per-item failure isolation, so one bad reference degrades one record instead
  of aborting a run, and the run is told which degraded and why;
- a cap on how much a single run may fetch, so a cold store does not hand an
  upstream service its whole backlog at once.

That is complexity pushed **up** into every consumer. An extension slot in the
pipeline would absorb none of it: a slot is a place to put code, not an answer
to any of the five. A library is.

Two consumers pull the design in usefully different directions – IIIF image
dimensions (many hosts, per-record, dataset-scoped) and GeoNames places through
the Network of Terms (one host, batched, register-wide) – which is a better
basis for an interface than either alone.

## Decision

A standalone package, `@lde/resolver`, with a narrow interface:

```ts
createResolver({ key, fetch, store, limits, report }).resolveAll(references);
```

The caller selects what needs resolving and applies what comes back. The
resolver knows only **references, keys and facts** – no item generic, no
`select`, no `apply`, and therefore nothing about quads, documents, stages or
pipelines. That matters concretely: inside a `QuadTransform`, “applying” means
minting quads, which no `apply: (item, facts) => item` can express.

**Three outcomes, not two.** A key resolves to a fact, to an `absent` – the
source answered and has none – or to an `unresolved`, which says only that we do
not know: a fetch failed, timed out, went down with its host, or the budget
deferred it. Collapsing the last two loses the distinction a consumer needs
most, because `absent` may be indexed as “this record has no such value” while
`unresolved` may not, on pain of baking a passing outage into an index until the
next rebuild. One flat discriminant carries it; nothing is nested under it, and
there is no accessor that collapses the two, because such an accessor would be
the default path and would reintroduce exactly that bug.

**No dependency on `@lde/pipeline`.** The two things that pull towards coupling
are both injectable: reporting is a callback rather than a `ProgressReporter`
import, and the batch memory bound is satisfied by the caller passing one batch
at a time. So a deployment calls the resolver from inside its own transform –
no pipeline adapter, no second extension point, no amendment to ADR 2.

**The store is a seam with a durable default.** `FactStore` is the deliverable,
`sqliteFactStore` (on `node:sqlite`, so no dependency) is the default, and
`memoryFactStore` is for tests. `FileProvenanceStore` is the precedent for the
seam but not for the backend: it reads the whole file on every access, which
suits one record per dataset and not one per external identifier accumulating
across every dataset and run.

Nothing here is ever queried by anything but key – staleness, absence expiry and
the version are all decided per row after looking it up – so SQLite is not
chosen for its query engine. It is chosen over a file per key for scale: a small
derived fact costs a row rather than a 4 KB block and an inode, an IRI is a
primary key rather than a filename that must be hashed to fit, a batch read is
one query rather than hundreds of round trips on a network volume, and the whole
store is one file to copy or mount. What it costs is single-writer semantics,
so writes open with a busy timeout; WAL is deliberately not enabled, since it
needs shared memory that network filesystems commonly lack and would fix
reader/writer contention this access pattern does not have. A deployment that
needs many concurrent writers can ship a file-per-key `FactStore` instead – that
is what the seam is for.

**`check()` proves the write.** Opening the store proves nothing once it exists:
a database left by an earlier run opens cleanly, and even takes a transaction,
when its file or directory is no longer writable – the realistic failure, from a
remounted volume or a changed `runAsUser`. So `check()` writes a row and rolls it
back. Without that, the failure surfaces at the end of the first batch, with the
run’s fetch budget already spent on facts that cannot be kept, on every run
thereafter.

**Absences are remembered; failures are not.** An absence is an answer, and an
unremembered answer is asked again every run: a key the source does not know
would return to the store as missing, sort ahead of merely stale keys, and spend
the budget re-asking a settled question – so a register with a tail of unknown
keys would never warm. A failure is the opposite: transient, so it is never
persisted and the whole batch is simply retried next run. Absences carry their
own TTL, finite by default where a fact’s is not, because an absence is the
weaker claim.

**A TTL marks stale; only `purge` removes.** The store is the only place the
fact lives, so eviction is data loss. Neither consumer has a validator to
revalidate against – GraphQL on one side, inconsistently conditional
`info.json` responses on the other – so `ETag`/`Last-Modified` revalidation and
multiple key spaces for facts of differing volatility wait for a consumer that
actually has validators.

**Facts are small derived values, and carry the version that derived them.**
The store loads every requested key into memory at once, so a batch of keys is
a memory bound only when a fact is bounded too (ADR 12): the IIIF consumer
stores the dimensions and the `sizes` ladder, not the multi-megabyte manifest
they came from – keeping the document is caching an HTTP response, a different
job with different rules. Because a fact is a projection, the projection has a
version: a row stamped with another one reads as missing and is fetched afresh.
Nothing else can express it – such a row is not old, so no TTL applies, and
`purge` would need the caller to enumerate every key it ever wrote.

**A run’s budget is per resolver, not per call**, and is spent on keys with
nothing stored before keys that are merely stale. The counter never resets, so
a resolver is a run-scoped object: `fetchesPerResolver` is named for what it
bounds, and a resolver kept alive across runs stops fetching once its budget is
gone. Budget deferral is not reported – it is the cap working, the caller
already has it in the returned resolution, and on a cold register-scale store
one callback per deferred key is a flood that buries the failures that matter.

**Bounding is owned, not delegated – and so is waiting.** The resolver applies
the global and per-host caps itself, through `@lde/host-limiter` – promoted out of
`@lde/distribution-probe` by this work. Libraries get this wrong often enough
that it cannot be assumed of a caller’s HTTP client. The same argument settles
the deadline, more forcefully: an unbounded request rate is rude, but an
unbounded wait means `resolveAll` never settles and the run hangs with nothing
thrown and nothing reported. So an attempt has a finite default timeout and
`fetch` is handed an `AbortSignal` to cancel with. `@lde/host-limiter` is a leaf
package with no dependencies precisely so that taking it on does not give the
resolver a pipeline dependency through the back door.

**The host is declared, never inferred.** `host` is required – a constant for a
single endpoint, a function when references are fetched from the hosts they
name. Defaulting it to the key’s host would be silently wrong for any source
reached through an aggregator, proxy or batching API, where the key names one
host and the request goes to another: the caps and the breaker would then govern
hosts the resolver never contacts while the one it hammers went unbounded.

**A host that keeps failing is written off for the run.** Retrying every
reference against a host that is down is the stampede, not the remedy – and it
costs the run’s wall clock, not just the host’s patience. After
`hostFailureThreshold` consecutive failed batches (five by default, each already
past its retries), the remaining batches for that host answer without a request.
The threshold is a limit rather than a constant because the breaker cannot see
_why_ a batch failed – a 400 on one malformed IRI throws exactly as a dead host
does – and at the default `batchSize` of 1 a batch is a single reference, so too
low a threshold writes off healthy hosts over a couple of bad references. Written-off references are refunded to the fetch
budget, since they sent nothing; and because the breaker lives on the resolver
rather than in the store, a host that recovers is retried on the very next run
instead of waiting out a persisted backoff.

**Naming.** _Transforms rewrite what the graph said; resolvers fetch what it
only pointed at._ That rule distinguishes this from ADR 2’s quad transforms
without needing to read an ADR, and it is why this is not called “enrichment” –
which says only that something got better, not where the data came from.

## Consequences

- A deployment that fetches from outside writes a `fetch` and an application of
  the results, and inherits storage, bounding, retry, isolation and the volume
  cap. The five problems are solved once.
- Facts survive an index rebuild, so a rebuild does not re-fetch every external
  reference, and a newly selected dataset referencing an already-resolved key
  costs no outbound call.
- A failing resolution degrades one **batch**, which is one reference at the
  default `batchSize` of 1. Raising it for a source that takes a list trades
  throughput against that blast radius: a source that rejects a batch over one
  malformed member takes the rest of the batch with it. The failures are
  transient and unpersisted, so the next run retries the batch whole; what is
  deliberately not done is re-attempting a failed batch as single references,
  since the common failure is source-wide and re-asking would multiply traffic
  against a host that has just failed.
- `resolveAll` answers `resolved` (with `fromStore` and `fetchedAt`), `absent`
  (with the stamp of when the source was found to have none) or `unresolved`
  (with a reason) per key, and `report` is called for what failed or degraded –
  so a run can log what aged, what broke and what is missing.
- A cold store warms over several runs rather than in one burst. A run under a
  spent budget still completes, on stored values.
- The package is testable without a pipeline: its edge cases are unit tests, not
  integration runs.
- A wrong fact is durable until purged. That is the accepted cost of having no
  validator, and `purge` is the stated remedy rather than an oversight.
- Omission is the stronger claim of the two a source can make: a thrown failure
  ages a stored fact, while an empty answer replaces it and is then believed for
  `absenceTtlMs`. A source that can be empty for reasons other than “no such
  thing” – reindexing, a maintenance window, a partial page – must throw rather
  than return nothing, and only the caller’s `fetch` can tell the difference.
- One more package to publish and version, and a second one for the scheduler.
  Both are leaves, which is what makes them usable from the lowest layers.
