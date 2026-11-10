# 33. Report the values a typed field could not read

Date: 2026-11-10

## Status

Accepted

## Context

A typed field reads a value or leaves it out. A `date` over `Z.j`, an `integer`
over `onbekend`, a `reference` over a literal: each is dropped, and the document
is indexed without it. Nothing says so. A publisher’s unreadable dates vanish
from every date filter, and the only way to find them is to inventory the dumps
by hand.

That inventory, run on the four Linked Open Limburg datasets on 10 November
2026, found 1 unreadable `dateCreated` of 756 in the Limburgs Museum, 11 of 136
in the Discovery Museum and 27 `temporalCoverage` values of 31 in Tracé
decorbladen (ldelements/lde#1022). LDMax declined to reinterpret such dates in
its ETL and asked for them to be corrected in the collection system
(mightymax/ldmax-feedback#16). A correction at the source needs the list first.

The pipeline already reports items a writer refuses (`itemsRejected`). That is
a different failure: the item is gone, where here only a value is.

## Decision

The projection reports every value a typed field leaves out, and the pipeline
reports them per dataset.

- **Every kind that can refuse a value reports**: `integer` and `number`
  (`NaN`), `date`, `period`, `reference` (a literal where an IRI belongs) and
  `boolean` (a value outside `true`/`false`/`1`/`0`). A `keyword` or `text`
  field reads any literal, so it has nothing to report. Reporting two kinds
  would let a reader assume the others are clean.
- **Both value routes report.** A `derive` mostly passes a source value through,
  so a value it returns that the field cannot read is usually the source’s too;
  when it is the derive’s own bug, that is worth surfacing as well. A value that
  is not a string is reported as `String(value)`.
- **`@lde/search` reports, and knows nothing of reporters.**
  `ProjectionContext.onUnreadable({ field, value, id })` is called once per
  value. `field` is dotted for a nested referent; `id` is the node the document
  came from, which is what a publisher can look up.
- **`@lde/pipeline` tallies.** A `BatchTransform` reports through
  `BatchContext.valueUnread(target, field, { id, value })`, and the pipeline
  keeps a count and at most 5 distinct examples per (target, field) for the
  dataset in progress. It emits `ProgressReporter.valuesUnread` per field just
  before `datasetComplete`, and nothing for a dataset that failed, since nothing
  of it is kept. Tallying in the pipeline, rather than in
  `searchIndexerPipeline`, means a `Pipeline` built from `searchStages` directly
  reports too.
- **`ConsoleReporter` prints it under the dataset**, shaped like
  `itemsRejected`, rather than in a summary at the end of the run, which would
  hold every dataset’s report until then.

## Consequences

- An operator sees, per dataset and field, how many values the index lost and a
  few of them with the node they came from.
- Memory follows the schema, not the data: one tally per field that rejected
  anything, bounded in examples (ADR 12).
- Every `BatchTransform` receives `valueUnread`, and may ignore it.
- A report a publisher reads without an operator in between is not part of
  this. It is another reporter on the same hook.
