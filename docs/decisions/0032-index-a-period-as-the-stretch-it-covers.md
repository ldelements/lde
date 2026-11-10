# 32. Index a period as the stretch it covers

Date: 2026-11-09

## Status

Accepted

## Context

A `date` field holds one instant per value, and serves, filters and sorts that
same instant. Heritage data often knows less than an instant: a work was made
somewhere in 1935–1955, around 1620, in the 1620s. SCHEMA-AP-NDE 1.8.0 lets a
publisher say so, accepting EDTF Level 0 and 1 on `dateCreated`, `birthDate`,
`deathDate` and `temporalCoverage`.

A consumer of `@lde/search` had two ways to index such a value, and both lose
it. Reducing an interval to its start serves `1935/1955` as `1935`, which reads
as more certain than it is, and leaves the work out of a filter on 1940–1950.
Dropping what does not reduce loses `1620~` and `162X` altogether. Linked Open
Limburg did the first and, for qualifiers, the second (ldelements/lde#1015).

Splitting a period into two public `date` fields fixes the indexing but not the
API. A client filters on names it never reads in a response, and has to write
the overlap test itself, where the obvious mistake – a range on the start field
alone – silently misses every period that began before the range.

## Decision

Add a `period` field kind. It is declared, served, filtered and sorted under one
name, and stored as three things: the values verbatim, and the first and last
second they cover in two hidden int64 companions (`${name}_start`,
`${name}_end`).

- **Output** is each value as its source stated it, typed `EDTF` in GraphQL.
  A qualifier is part of what is known, and how to render it depends on the
  reader’s language, so the client renders it.
- **A range filter matches by overlap**: the period starts no later than `max`
  and ends no earlier than `min`. The input is the existing `DateRange`, read by
  the existing date codec.
- **Sorting** ascending orders on the start, descending on the end.
- **An open or unknown bound** is stored as ±2⁶², so the overlap needs no
  special case. Unknown reads as open: a work left out of results it might
  belong to costs a reader more than an extra hit.
- **An `array` field** is stored as the one stretch its values cover between
  them. Per-value bounds would need a welded condition per value and could not
  be sorted on; multi-valued periods are rare enough that the envelope is the
  better trade.
- **Parsing** reads each side of an interval through the date codec, which
  reads every `date` lexical form and deep time. What only EDTF states is
  rewritten into a form the codec reads: a qualifier dropped, an unspecified
  month or day dropped to the coarser precision, unspecified year digits read
  as their lowest and highest. A season is read as its whole year, since EDTF
  fixes no months for it. We tried edtf.js for these: it holds dates in `Date`,
  so any interval with a deep-time side failed, and what it added over the
  codec came to a few rewrites.

A period is **not facetable**. It belongs in every bin it overlaps, and an
engine facet counts a document once, from one value. It is filtered only on the
document that holds it, never through a nesting or a weld, since a weld compares
one value per condition.

## Consequences

- A client reads, filters and sorts one field, and cannot get the overlap
  wrong.
- A value read back is no longer always a valid filter bound: `1935/1955` is
  not a `DateRange` bound. Making `DateRange` accept EDTF bounds would restore
  that, and can be added without breaking anything.
- The companions are written for every period, so a display-only period costs
  two int64 values per document. In return, a deployment can sort on a period
  it does not expose as sortable, and making one filterable needs no reindex.
- Faceting a period is open. Counting a document in every bin it overlaps needs
  the bins fixed at projection time (a multi-valued bin field), which changes
  when a bin change takes effect.
