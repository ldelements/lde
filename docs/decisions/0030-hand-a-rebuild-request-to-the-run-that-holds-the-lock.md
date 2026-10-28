# 30. Hand a rebuild request to the run that holds the lock

Date: 2026-10-28

## Status

Accepted

## Context

A search rebuild is single-flight per index across pods. `@lde/search-typesense`
takes a lock in Typesense when a run opens, and a run that finds the lock held
throws `RebuildAlreadyRunning`. A rebuild started for a change that lands while
another rebuild runs is therefore dropped. The running rebuild read its source
before the change, so the change stays out of the index until something
rebuilds again.

The Dataset Register hit this. It rebuilds after the hourly crawl and after a
delete, but not on registration: rebuilding per registration fails in a burst,
because only the first rebuild runs and the rest hit the lock. A dataset
registered on 28 October at 13:27 could not become searchable before the 14:00
crawl. The crawler loses its own rebuild the same way when an API pod holds
the lock.

A rebuild of the Dataset Register’s 3434 datasets takes 7–10 s, measured over
the 24 hours before that date.

An Elasticsearch port would need the same lock and would hit the same problem,
so the fix cannot live in the Typesense port or in each app.

## Decision

A pod that wants a rebuild records a request next to the index’s lock, then
runs the rebuild. When the lock is held, it stops: the holder reads the
requests after its run and runs again when one arrived since it began.

- `@lde/search` exports `requestRebuild(rebuild, requests)` and
  `RebuildAlreadyRunning`, which moves there from `@lde/search-typesense`.
- `@lde/search/adapter` exports `RebuildRequests`: `record()` and `latest()`,
  implemented by each engine port on its own store.
- `@lde/search-typesense` exports `TypesenseRebuildRequests`, one document per
  index in a `rebuild_requests` collection. It cannot share `rebuild_locks`,
  because releasing a lock deletes its document and the request must outlive
  the release.

A requester records before it tries the lock, and the holder reads after its
run released it, so either the requester takes the lock or the holder sees the
request.

A failed run rejects without running again; requests recorded during it wait
for the next `requestRebuild`. Every rebuild of the index must go through
`requestRebuild` with the same `rebuild`, because the holder runs its own on
another caller’s behalf, and a run started any other way never reads the
requests.

### Rejected: debounce and retry in each pod

Each pod would wait for a quiet period after the last trigger, then retry while
the lock is held, up to the lock TTL. That needs timers, a retry cap, a
`close()` for shutdown and a separate awaitable function for one-shot callers
such as the crawler. Two overlapping pods run a redundant rebuild, because the
waiting pod cannot tell whether the holder read its source before or after the
change. And a pod retrying on a held lock takes it over once the TTL expires,
even when the slow run is still going.

With a 10 s rebuild, a quiet period of 30 s would only delay the index.

### Rejected: cancelling the running rebuild

The crawler’s rebuild could cancel one already running. That needs a stop
signal across pods and a check at the alias swap for a cancel that arrives as
the run goes live. It saves one rebuild’s wait. The run being cancelled is also
newer than what is live, so finishing it improves the index sooner.

## Consequences

- A burst of requests during one run costs a single rerun, and the first run
  starts immediately. Requests that keep arriving keep the holder running
  until one run sees none.
- A pod that dies mid-run leaves the requests for the next `requestRebuild`.
- No pod waits on a held lock, so a TTL takeover stays rare. The lock itself
  still has no heartbeat or owner, so a run outliving the TTL can lose it; that
  is tracked separately.
- Moving `RebuildAlreadyRunning` is a breaking change for importers of
  `@lde/search-typesense`.
- An engine port implements `RebuildRequests` next to its lock.
