# 45. Mark a document with the stored filters it matches

Date: 2026-11-24

## Status

Proposed

## Context

A deployment wants named subsets of one index: every work about a given term,
say, shown as a collection of its own beside the whole. Two ways exist today,
and neither serves several subsets from one index.

- **Restricting the roots** (`restrictRoots`) gives correct facet counts, but
  the index then holds only the subset. Each subset needs its own indexer run,
  its own collections and its own API.
- **A filter in the query** keeps one index, but the subset is then a clause on
  the field that defines it. A facet drops its own clauses when it counts
  ([ADR 29](0029-make-skip-own-filter-what-a-facet-means.md)), so the facet on
  that field counts the whole index. Measured on Linked Open Limburg: with
  `about` filtered to one term matching 1309 works, the `about` facet lists a
  bucket of 11090.

The subset is also not the schema’s to define. Which subsets exist changes far
more often than the fields do, and the people who decide it are not the people
who write the schema module. An application that lets them save a search as a
subset needs a format to save it in, and a second deployment must be able to
read that format.

## Decision

A run takes **stored filters**: a list kept outside the schema, each entry a
root type, a filter and a value. Every document is tested against the filters
of its type as it is projected, and gets the value of each one it matches.

```json
[
  {
    "type": "CreativeWork",
    "value": "https://example.org/selections/pottery",
    "filter": {
      "op": "a_contains",
      "args": [{ "property": "about" }, ["https://example.org/terms/pottery"]]
    }
  }
]
```

- **A projection value, `from: 'matchedFilters'`.** The values land in a field
  the type declares, as the dataset does in a `from: 'dataset'` field. The
  field is an ordinary `keyword` or `reference`: filterable, facetable or
  neither. A query selects a subset with a clause on that field. Declared
  filterable and not facetable, no facet owns that clause, so every facet
  counts within the subset.
- **The filter is CQL2 JSON.** It is an OGC standard, it is what the NDE
  integration-layer specification uses for search, and it is plain data. A
  property is a field of the type, by its declared name. Read today: `=` and
  `in` on a single-valued field, `a_contains` and `a_overlaps` on an `array`
  field, combined with `and` and `or`.
- **Tested during projection, at the field’s place.** A filter reads the
  document as populated so far, like a `derive`. A reference to a keyed type
  already holds the target’s key by then, so a filter names the key and matches
  whatever IRI the publisher used. The field is therefore declared after the
  fields its filters read.
- **Checked before the run.** `compileStoredFilters` refuses, in one error
  listing every problem: a type the schema lacks, a keyed type, a type without the field, a
  value a `reference` field cannot store, a property that is unknown, declared
  too late, or not a `keyword` or non-inline `reference`, and an operator that
  does not fit the field.
- **A filter, not a search.** An entry holds a type, a value and one CQL2
  expression, and any other key is refused. A saved search with a text query,
  an order or a review step belongs to the application that keeps it; what
  reaches a run is the filter of each search one document can answer.
- **A field without a value matches nothing.** `not` is refused for now. What
  it means for a document that lacks the value has to be the same here as in
  an engine that runs the filter as a query, and no adapter does that yet.
- **The indexer reads a file.** `STORED_FILTERS_FILE` names a JSON file with the
  list. The filters extend the pipeline version, so changing one re-indexes
  every dataset.

- **A package of its own reads the filter.** `@lde/cql2` checks a filter
  against the properties it may name and tests a record, and knows nothing of
  search. `@lde/search` tells it which fields are properties. A later REST
  surface, or a compiler from a filter to SPARQL, can then read the same
  filters without depending on the search packages.

The evaluator is our own, about 200 lines. `cql2-wasm` (0.5.6) was tried
first. It throws on `=` against an absent property, accepts an unknown operator
as valid, and has no notion of which properties exist, so the property and
operator checks would have been ours either way.

## Consequences

- A subset is a value on the document. One index, one API and one schema serve
  any number of them, and facet counts within a subset are right.
- A subset changes at the next indexing run, not before. Applying a changed
  filter to the live index needs the filter compiled to a query and the
  difference patched; that is a later step, and the reason the format is one an
  engine adapter can compile.
- [#1024](https://github.com/ldelements/lde/issues/1024) proposed a query-time
  scope for the same need and was closed. This replaces it for subsets known at
  indexing time. A scope argument that a facet on the field itself respects is
  still open.
- Only `keyword` and non-inline `reference` fields can be filtered on. Text,
  numbers, dates, periods and an entry’s leaves are refused until asked for.
- A filter cannot reach into a referent: “works whose creator was born in
  Maastricht” needs the creator’s document, which the projection of the work
  does not hold.
- A stored filter on a type keyed on a declared field is refused. Several
  roots become one of its documents, which would hold the values of whichever
  root was written last, as [ADR 25](0025-record-which-datasets-reference-a-document.md)
  found for a `from: 'dataset'` field.
- A document is marked where it is projected as itself. A copy nested in a
  referrer by a `local` lookup carries no values: it holds only what the
  referrer’s extraction read, so a filter could answer differently there.
- Each stored filter costs one test per document of its type.
