# 35. Serve a property’s literals and references in one field

Date: 2026-11-10

## Status

Accepted

## Context

SCHEMA-AP-NDE gives `schema:temporalCoverage` two forms: a literal (an ISO 8601
date or interval, or an EDTF value) or a reference to a period, a
`schema:DefinedTerm` with a name. A `period`
([ADR 32](0032-index-a-period-as-the-stretch-it-covers.md)) drops IRIs. A
`lookup` reports literals as unreadable
([ADR 33](0033-report-the-values-a-typed-field-could-not-read.md)) and drops
them.

Publishers use both forms. In the dumps of Linked Open Limburg’s four datasets
of 10 November 2026, Tracé’s decorbladen state their period only as a term, on
all 17574 works, while the literal form occurs on 30 of Tracé’s
`ArchiveComponent`s. A deployment serving the whole property today declares
two fields over one path (`temporalCoverage: [EDTF!]!` and
`temporalCoverageTerm: [TermReference!]!`), and a client that shows the period
has to know the profile allows two forms and query both. The API does not link
the two fields.

## Decision

A `lookup` reference may declare `literal: 'period'` on its strategy. It then
reads a literal stated in place of a referent as a period.

- **One list of entries.** At the port, each entry is a period, as a string,
  or a referent, as any lookup resolves it. GraphQL serves the list as
  `‹Target›OrPeriod { value: EDTF, reference: ‹Target›Reference }`, with
  exactly one of the two set. The name derives from the declared target, so
  LDE adds no concept of a term. A single-valued field keeps the first value
  either form can read.
- **Stored as each form is stored today.** The referents’ ids stay under the
  field’s own name, so lookup resolution and re-keying work unchanged. The
  periods go into a `${name}_literal` companion with the `${name}_start` and
  `${name}_end` bounds a `period` has.
- **Filtered by the periods alone.** The field takes a period’s `range`, which
  matches by overlap. A referent has no bounds, so it matches no range and
  sorts as a work with no period does. The field takes no `in`: filtering on
  the referents is out of scope, and a second operator would break the rule
  that a field takes one operator. `filterOperatorFor` therefore takes the field
  rather than its kind.
- **Not facetable**, as a `period` is not: a bucket per referent would offer a
  selection no filter makes.
- **Neither `local` nor `joinable`, and not nested.** A `local` lookup stores
  each referent as an object, a join filters on ids, and a nested entry cannot
  hold two bounds a weld compares.
- **`'period'` only, for now.** `LiteralKind` is a union, so it can widen.
  `PropertyValue.propertyID` (Text or URL) needs a `keyword` literal beside an
  IRI, but on an `idOnly` reference inside an inline Reference Type, whose
  output is a bare IRI. That is a separate change.

We considered a `period` field that also accepts a `ref`. Lookup resolution is keyed on `kind: 'reference'` in the
port, the Typesense adapter and the GraphQL surface, so every one of those
checks would need a second case. An inline Reference Type with a
`literalField` was also ruled out: a nested period cannot be range-filtered.

## Consequences

- `filterOperatorFor(field)` replaces `filterOperatorFor(kind)`, a breaking
  change to `@lde/search`.
- A term’s period cannot be filtered. The profile gives a `DefinedTerm` no
  bounds, and the Network of Terms serves none for periods; bounds for terms
  would be a separate decision.
