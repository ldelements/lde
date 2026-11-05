# 25. Record which datasets reference a document

Date: 2026-08-31

## Status

Accepted

Completes [ADR 22](./0022-key-a-root-type-on-a-declared-field.md), whose keying
this repairs; bounded per [ADR 12](./0012-bound-memory-by-the-unit-of-work-not-the-input.md).

## Context

ADR 22 lets a Root Type key its documents on a canonical identifier, so two
datasets referencing the same GeoNames place produce **one** document. The
writers still stamped each document with one `source`: the dataset that wrote it
last. Both deletion paths then destroyed live data. A departing dataset deleted
the documents another still referenced; and a dataset’s stale sweep deleted what
a dataset skipped as unchanged still pointed at – leaving that dataset’s
references dangling, with nothing to rewrite them.

## Decision

**Membership is a set of referrers, on the collection that can share documents.**

A keyed collection carries a private `referenced_by: [{ dataset, run }]`. A
write adds the dataset, a sweep removes it, and the document is deleted only
when the last referrer goes. A dataset skipped as unchanged is safe by
construction: only its own sweep touches its entry.

Three things follow.

- **The run is `Date.parse(startedAt)`, not the run id.** Typesense correlates a
  comparison inside a nested element but **not** a negation, so “this dataset
  did not write it this run” has to be asked as `run:<thisRun`. With `!=` the
  filter silently answers at document level and sweeps nothing. Pinned in
  `membership-filters.integration.test.ts`.
- **A keyed type may not declare a `from: 'dataset'` field.** It would hold
  whichever dataset wrote last, so a user filtering by any of the others would
  miss the document.
- **Retraction reads and rewrites in pages**, re-asking the filter rather than
  paginating: a touched document stops matching, so memory is one page whatever
  the collection holds.

Collections whose type declares no `key` are untouched: one `source`, one
`last_seen`, deletion by filter.

## Consequences

An existing keyed collection must be **dropped and the pipeline version
rotated** – the field cannot be added to a live collection, and a rebuild
without the rotation is repopulated only by the datasets that changed. The
writer fails with both steps named. Unkeyed collections need no migration.

A write to a keyed collection costs one extra read: Typesense replaces whole
documents and cannot append to an array, so the stored set is read back per
batch. Unkeyed collections keep their single request.

A shared document’s fields stay last-writer-wins (ADR 22), so where an authority
did not describe a term, values written by a departed dataset can persist until
a remaining referrer rewrites them.

## Rejected

**A marker exempting shared documents from sweeping.** It makes them immortal:
a document nothing references any more is never collected, and it misses
canonical documents the authority could not describe.

**Membership in a side collection**, one row per (document, dataset). Writes get
cheaper, but “which documents now have no referrer” is an anti-join Typesense
cannot express, so the read-modify-write only moves – at the price of a second
collection per type, with its own locking and rollback.
