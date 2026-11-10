# @lde/resolver

Everything around fetching a fact from **outside the graph**: a durable store,
bounded outbound work, retry of only what a retry can fix, per-key failure isolation and a cap
on how much one run may fetch. A caller writes the fetch and what to do with the
answer, and nothing else.

_Transforms rewrite what the graph said; resolvers fetch what it only pointed
at._ That is the whole distinction, and why this is not called “enrichment”:
enrichment says only that something got better, not where the data came from.

```ts
import { createResolver, sqliteFactStore } from '@lde/resolver';

const resolver = createResolver<string, Place>({
  key: (iri) => iri,
  // The host contacted, which is not the host the keys name.
  host: 'termennetwerk-api.netwerkdigitaalerfgoed.nl',
  fetch: async (iris, { signal }) =>
    (await lookup(iris, { signal })).map((term) => [
      term.uri,
      coordinatesOf(term),
    ]),
  store: sqliteFactStore({ path: '/data/places.sqlite' }),
  version: '1',
  limits: {
    batchSize: 25,
    fetchesPerResolver: 5_000,
    ttlMs: 30 * 24 * 3_600_000,
  },
  report: (failure) => console.warn(failure.key, failure.reason),
});

const resolved = await resolver.resolveAll(placeIris);
switch (resolved.get('https://sws.geonames.org/2751283/')?.outcome) {
  case 'resolved': // .fact, .fetchedAt, .fromStore – use it
  case 'absent': // the source has none – index the record without one
  case 'unresolved': // we do not know – leave the field alone
}
```

## Installation

```sh
npm install @lde/resolver
```

## What it knows, and what it does not

References, keys and facts. Not quads, documents, stages or pipelines – there is
no dependency on `@lde/pipeline`, so the package is testable without
constructing one and usable by anything doing bounded outbound work.

A pipeline therefore calls it **from inside its own `QuadTransform`**. That is
the seam ([ADR 2](../decisions/0002-unify-pipeline-extension-on-quad-transforms)),
and it is a good place to be: a transform attached to a reader sees the
extraction output for a batch of roots, can tell an absent value from a present
one, and mints its results through `irAlias()` so the schema shapes them like
any other value – rather than the resolver re-implementing a projection.

## Three answers, because there are three moves

`resolveAll` answers per key with `resolved`, `absent` or `unresolved`, and the
middle one earns its place:

- **`resolved`** – use the fact. `fromStore` says whether this run fetched it,
  and `fetchedAt` how old it is.
- **`absent`** – the source answered and has none. That is durable, so a record
  may be indexed as having no such value.
- **`unresolved`** – we do not know: the fetch failed, timed out, went down with
  its host, or the budget deferred it. Indexing this as an absence bakes a
  passing outage into the index until the next rebuild.

There is no accessor that collapses `absent` and `unresolved`, deliberately: it
would be the path of least resistance and would reintroduce exactly that bug.

## The store is the only copy

A pipeline re-reads its publishers’ data every run and a search index is rebuilt
from its sources, so a fact fetched from a third party has **nowhere else to
live**. `FactStore` is that place, and the two consequences run through the rest
of the design:

- **A TTL marks stale, it never evicts.** An elapsed TTL makes a key a candidate
  for a refresh; if the budget or the source denies it, the stored fact is still
  served. Eviction here would be data loss, not cache management.
- **Removing a fact is explicit.** `resolver.purge(keys)` is the only way, and
  the answer to a fact that turned out wrong – nothing revalidates, because
  neither known consumer has a validator to revalidate against.
- **An absence is remembered too**, under its own `absenceTtlMs` (a week by
  default, even when `ttlMs` is unset – an absence is a weaker claim than a
  fact). Without this, a key the source does not know returns as missing every
  run, sorts ahead of merely stale keys and spends the budget re-asking a
  settled question, so a register with a tail of unknown keys never warms.
- **A failure is not remembered.** It is transient, so the batch is simply
  retried next run – within the run, a host that is down is handled by the
  breaker below rather than by a record that would hide its recovery.

### Facts are small derived values

`get` loads every requested key into memory at once, so a batch of keys is a
memory bound only when a fact is bounded too. Store the image dimensions, not
the multi-megabyte manifest they came from: keeping the document is caching an
HTTP response, a different job with different rules. If a deployment wants both,
give them separate `table`s and separate `batchSize`s – facts sized in bytes and
facts sized in megabytes cannot share one budget.

### The version that derived them

Because a fact is a projection, the projection has a version. Bump `version` in
the same commit that changes what you derive, and rows stamped with the old one
read as missing and are fetched afresh. Nothing else can express it: such a row
is not old, so no TTL applies, and `purge` would need you to enumerate every key
you ever wrote. Expect to raise `fetchesPerResolver` for a few runs while the
store re-warms.

`sqliteFactStore` is the default backend, on Node’s own `node:sqlite`, so keyed
reads and single-row writes cost no dependency. `memoryFactStore` is for tests.
The interface is a seam: a deployment may back it with anything.

**A store is process-scoped where a resolver is run-scoped.** The store is the
thing that survives runs, so build one and hand it to as many resolvers as the
process makes, rather than building one per run – and call `close()` when the
process is done with it. `node:sqlite` is loaded on first use rather than at
import, so importing this package costs nothing on a runtime without it; the
manifest declares `engines.node >= 24` all the same.

## What a run may spend

`fetchesPerResolver` caps how many references one **resolver** fetches,
refreshes included – not one `resolveAll`, so a caller passing many batches is
still one run. Without it, the first run after a cold or purged store hands an
upstream service the entire backlog at once. With it, the store warms over
successive runs and every run still completes: what is not fetched degrades to
the stored value, or is answered `unresolved`.

The counter never resets, so **a resolver is a run-scoped object**: construct
one, use it, discard it. A resolver kept alive across runs stops fetching when
its budget is gone and never starts again.

Within the budget, **a key with nothing stored is fetched before one that is
merely stale** – a missing fact costs the caller a value, where a stale one only
ages it. A deferral is not reported: it is the cap working, the caller already
has it in the returned resolution, and one callback per deferred key would bury
the failures that matter on the very run that produces most of them.

The default of 500 is tuned to be polite on a small store, not to fill a
register-scale one: a first run over 50 000 references at that setting warms 1%
of them. Set it to what your upstream can bear.

## Bounding, waiting and giving up on a host

Concurrency is bounded globally and per host through
[@lde/host-limiter](./host-limiter), which the resolver **owns** rather than
delegates: HTTP clients get this wrong often enough that it cannot be assumed
(see [IIIF-Commons/iiif-helpers#39](https://github.com/IIIF-Commons/iiif-helpers/issues/39),
where a client throttles on a single global counter borrowed from an unrelated
config key). The caps belong to the resolver, not to one `resolveAll` call, so
batches resolving in parallel – a `Stage` running a transform per batch, say –
share them. A batch never mixes hosts, so the per-host cap keeps meaning what it
says even at `batchSize` above 1.

`host` is **required**, and is either a constant – for a source reached through
one endpoint – or a function of the reference. It is deliberately not defaulted
to the key’s host: whenever `fetch` goes through an aggregator, a proxy or a
batching API, the key names one host and the request goes to another, and a
defaulted rule would bound hosts the resolver never contacts while leaving the
one it hammers unbounded. Pass `urlHost` when the key **is** the URL fetched.

`timeoutMs` (10 seconds by default) bounds one attempt, and `fetch` is handed an
`AbortSignal` to cancel with. This is owned here for the reason the caps are,
only more so: an unbounded request rate is rude, but an unbounded wait means
`resolveAll` never settles and the run hangs with nothing thrown and nothing
reported. Ten seconds is what `ky` and OkHttp default to, and six times what a
slow IIIF manifest took when measured; it bounds a whole call to `fetch`, so a
caller with a large `batchSize` may need to raise it.

A host is written off for the rest of the resolver’s life once
`hostFailureThreshold` of its last `2 × hostFailureThreshold` batches failed –
5 of the last 10 by default – and its remaining batches answer without a
request. A window rather than consecutive failures, so a host where most
references time out is cut off even when a few succeed in between: Limburgs
Museum’s manifests did exactly that, resetting a consecutive count for more than
24 minutes. Only systemic failures count (see below), so a run of broken
references never writes off a host whose other references resolve: a batch with
at least one fact or absence counts as a success, a batch the call threw for
counts as a failure, and a batch whose every key came back as a
`referenceFailure` does not count at all. A dead host costs the threshold in
batches before the breaker saves the rest, plus whatever was already in flight
against it – up to `perHostConcurrency` batches, which still run.
Retrying every reference against a host that is down is the stampede, not the
remedy, and it costs the run’s wall clock as much as the host’s patience.
Written-off references are refunded to the fetch budget, since they sent
nothing – and refunded in time to be spent on other hosts in the same call, so a
dead host cannot deny a live one an allowance it never used. The breaker lives on
the resolver rather than in the store, so a host that recovers is retried on the
very next run.

## Failure degrades a reference or a batch, not the run

The resolver never sees an HTTP response, so `fetch` says what went wrong by how
it reports it:

| `fetch` reports it by                  | Retried this run                                 | Counts towards a write-off | For                                                            |
| -------------------------------------- | ------------------------------------------------ | -------------------------- | -------------------------------------------------------------- |
| answering `[key, referenceFailure(…)]` | no                                               | no                         | one reference: a 500 on one image, a malformed document, a 403 |
| throwing                               | once, at the back of the queue, for a stall only | yes                        | the call: a 502, a 503 without `Retry-After`, a timeout        |
| throwing `RetryableError`              | up to twice                                      | only if it still fails     | a source that said to come back later: a 429                   |

**A thrown failure is not retried at once.** A 500 or a 502 a moment later is
the same 500 or 502, and the next run tries again anyway. The exception is a
stall that may pass: the resolver’s own timeout, or a broken connection –
`ECONNRESET`, `ECONNREFUSED`, `ETIMEDOUT`, `EAI_AGAIN`, `UND_ERR_SOCKET` or
`UND_ERR_CONNECT_TIMEOUT` on the error or its `cause`, where Node’s `fetch` puts
it. Such a batch queues again behind the batches already waiting for its host,
for one more attempt at no second unit of the budget, which counts references,
not requests.

The stall counts against the host when it first fails, not after that second
attempt, so a host that times out on everything is written off without every
reference paying a timeout first. The second attempt is not counted again,
whether it succeeds or fails. If the host is written off while the batch waits,
the batch is sent nothing more and keeps the reason it first failed for; it was
contacted once, so it is not refunded.

**A source that says to come back later** gets what it asked for. Throw
`RetryableError`, with `retryAfterMs` from `parseRetryAfter(response.headers.get('retry-after'))`,
and no new attempt against the whole host – not just the one reference – starts
until it has passed, because a rate limit is about this client. Attempts already
in flight finish, and the wait holds no concurrency slot, so other hosts carry
on. Without a delay – or with a delay of 0, which `Retry-After: 0` and a date
skewed into the past both give and which names no real wait – only that batch
backs off, 500 ms and then 1 s. After two retries, or for a delay longer than
`timeoutMs`, which is not waited out, the call fails for this run and counts
against the host like any other throw. If the host is written off while the
batch waits, it is sent nothing more and keeps its own reason and its charge.

```ts
fetch: async ([url], { signal }) => {
  const response = await fetch(url, { signal });
  const retryAfterMs = parseRetryAfter(response.headers.get('retry-after'));
  if (
    response.status === 429 ||
    (response.status === 503 && retryAfterMs !== undefined)
  ) {
    throw new RetryableError(`HTTP ${response.status}`, { retryAfterMs });
  }
  if ([502, 503, 504].includes(response.status)) {
    // A proxy whose backend is down: the host, not this image.
    throw new Error(`HTTP ${response.status}`);
  }
  if (!response.ok) {
    // This image, not the host: the others may well load.
    return [[url, referenceFailure(`HTTP ${response.status}`)]];
  }
  return [[url, dimensionsOf(await response.json())]];
};
```

Either way a failed key falls back to its stored fact or absence – or is
answered `unresolved`, with the reason – and `report` is called per key, saying
whether a stored value stood in (`degradedToStore`), so a run can log precisely
what aged and what is missing.

At the default `batchSize` of 1, a batch **is** one reference. Above that, a
throw takes the whole batch down, which is what `referenceFailure` is for: a
source that answers for a list but fails one member reports just that member. A
failed batch is deliberately not re-attempted as single references – the common
reason a call throws is source-wide.

A key the source simply **has nothing for** is not a failure and is not retried:
leave it out of what `fetch` returns and it resolves to `absent`, which is then
remembered.

Which makes omission the strongest claim a source can make, and the caller owns
it: an absence replaces a stored fact and is believed for `absenceTtlMs`, so a
source answering 200 with an empty result while it reindexes would erase what it
told us last week. If a source can be empty for reasons other than “no such
thing” – an empty page, a maintenance window, a partial response, an ambiguous
403 – detect it in `fetch` and **throw**, or answer a `referenceFailure`,
instead of returning nothing. A failure ages a stored fact; an absence replaces
it.

## Batching

`batchSize` defaults to 1 – one reference, one call. Raise it only for a source
that takes a list, where a batch of references is a single request: the Network
of Terms’ `lookup(uris: [...])` is the motivating case, and there the per-run
volume cap, not per-host concurrency, is what protects the store behind the API.

## API

| Export                      | Purpose                                                                      |
| --------------------------- | ---------------------------------------------------------------------------- |
| `createResolver(options)`   | Build a `Resolver` from `key`, `host`, `fetch`, `store`, `version`, `limits` |
| `Resolver.resolveAll(refs)` | Resolve references, one `Resolution` per distinct key                        |
| `Resolver.check()`          | Fail a run at startup when the store cannot persist                          |
| `Resolver.purge(keys)`      | Forget keys, so the next run resolves them afresh                            |
| `urlHost(key)`              | The host of a key that is itself the URL fetched                             |
| `referenceFailure(reason)`  | Fail one reference in `fetch`’s answer, without holding it against the host  |
| `RetryableError`            | Throw from `fetch` when the source said to come back later                   |
| `parseRetryAfter(header)`   | Read a `Retry-After` header as milliseconds, for `RetryableError`            |
| `sqliteFactStore(options)`  | Durable `FactStore` on `node:sqlite`                                         |
| `memoryFactStore(initial?)` | In-process `FactStore`, for tests                                            |

`Resolver.check()` writes a row and rolls it back rather than merely opening the
store: a database left by an earlier run opens cleanly, and even takes a
transaction, when its file or directory is no longer writable – a remounted
volume, or a pod now running as another user. Call it at startup, or the failure
surfaces at the end of the first batch with the fetch budget already spent.

Memory is bounded by what the caller passes to `resolveAll`: the resolver holds
that batch, its stored facts and its results, and nothing beyond them
([ADR 12](../decisions/0012-bound-memory-by-the-unit-of-work-not-the-input)). A
caller with more references than it can hold passes them a batch at a time – the
store carries what the previous batch learned.
