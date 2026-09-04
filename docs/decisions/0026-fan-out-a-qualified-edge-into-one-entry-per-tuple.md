# 26. Fan out a qualified edge into one entry per tuple

Date: 2026-09-02

## Status

Proposed

Amends [ADR 24 (Carry data on a reference edge)](./0024-carry-data-on-a-reference-edge.md),
which introduced the welded co-element filter but left the shape of an entry
under-specified. Relates to
[ADR 18 (Filter across several fields with one clause)](./0018-filter-across-several-fields-with-one-clause.md)
and [ADR 12 (Bound memory by the unit of work, not the input)](./0012-bound-memory-by-the-unit-of-work-not-the-input.md).

## Context

[ADR 24](./0024-carry-data-on-a-reference-edge.md) says the shape is **one entry
per edge**, and gives the welded filter that only an edge can answer: _this
agent in this role_, rather than “this role appears, and this agent appears,
somewhere in this document”. Unwelded, a work where X is the publisher and
somebody else is the photographer matches `role: fotograaf && creator: X`. That
false positive is the entire reason the nested entry exists.

What the ADR did not say is what an entry holds when the graph gives an edge
more than one value. Nothing stopped a nested leaf declaring `array: true`, and
two ordinary modelling facts push straight at it:

- a role may be stated once per language, so `role` arrives as two literals;
- the edge’s endpoint may be multi-valued, so `creator` arrives as two IRIs.

So the projection wrote entries like
`{ "role": ["etser", "etcher"], "creator_id": ["p1", "p3"] }`, and every
qualified relation in production carried them.

**Two things are wrong with that, and only one of them is a bug in somebody
else’s code.**

### The engine hangs

`typesense/typesense:30.2` – the current stable release – **hangs indefinitely**
on a welded filter whenever the entry holds arrays. Measured against a live
container, one document, no LDE code in the path:

```
c.{role:=etser && aid:=p1}     with role:["etser"] aid:["p1"]   → no response, ever
c.{role:=etser && aid:=p1}     with role:"etser"   aid:"p1"     → 1 hit, 5 ms
```

The trigger is narrower than “the fields hold arrays”: the hang needs both
conditions to find a match somewhere in the document **and** at least one matched
value to be array-valued. A single array-valued leaf on either side is enough –
`role:"etser" aid:["p1"]` hangs exactly as hard as both-arrays. A document that
matches neither condition is never slow, however array-shaped. At 1 000 000
documents the welded filter never returns, while either condition alone answers
in 16 ms.

Through the GraphQL surface that reaches a consumer as `Unexpected error`, the
5 s engine timeout retried once.

Typesense fixed it in the 31.0 release candidates – `31.0.rc1` hangs, `rc5`
through `rc14` answer correctly – but 31.0 has no stable release, and the
neighbouring upstream reports
([typesense#2469](https://github.com/typesense/typesense/issues/2469),
[typesense#2964](https://github.com/typesense/typesense/issues/2964)) are both
still open.

### The entry has no tuple to test

The engine bug is the reason this got noticed. It is not the reason to change
the shape.

A weld asks a question about **one element**: _is there an entry whose role is
`etser` and whose agent is `p1`_. An entry holding
`{ role: ["etser", "etcher"], creator_id: ["p1", "p3"] }` has no single answer –
it stands for four (role, agent) pairs at once, and the weld silently degenerates
into the cross-product it existed to exclude. Welding inside such an entry is the
same mistake as not welding at all, one level down.

So the array-valued entry is not a valid input the engine mishandles. It is a
shape that never had a meaning, which no engine could have answered, and which
[ADR 24](./0024-carry-data-on-a-reference-edge.md)’s own words – _one entry per
edge_ – already exclude.

## Decision

**A weldable nested leaf is single-valued, and multiplicity moves to the entry
list.**

Three parts.

### 1. A `filterable` nested field may not declare `array: true`

Refused by `searchSchema`, beside the Roles nesting already cannot serve. A
nested leaf that a weld can name states one value per entry, and a declaration
saying otherwise is refused at startup rather than producing entries no filter
can read.

`output`-only nested leaves are untouched: nothing welds them, so an entry may
carry a list for display.

### 2. The projection fans out one entry per tuple

Where the graph gives an edge several values for a weldable leaf, the projection
emits **one entry per combination**, each leaf single-valued:

```jsonc
// the graph
{ "role": ["etser", "etcher"], "creator": ["p1", "p3"] }

// the entries
[ { "role": "etser",  "creator_id": "p1" },
  { "role": "etser",  "creator_id": "p3" },
  { "role": "etcher", "creator_id": "p1" },
  { "role": "etcher", "creator_id": "p3" } ]
```

Fan-out happens on the **framed node**, before the entry is projected, so each
leaf passes through `transform`, folding and the facet companion exactly as a
single-valued field always has. Nothing downstream learns a new shape.

Nothing is dropped: the four entries carry what the two arrays carried. What
changes is that each one now answers the weld.

### 3. Language variants are labels, not values

A role stated once per language is **one** role. Declaring `role` multi-valued to
hold `"etser"@nl` and `"etcher"@en` models a labelling accident as data, and
fan-out would then emit two entries for one relation and facet them into two
buckets.

Index the role’s canonical IRI, single-valued, and resolve labels at the surface
like every other reference. Measured on 1 000 000 documents this halves the
entries per document (3.74 against 7.49) and gives 15 facet buckets rather than
30 that split one role across languages.

### What bounds it – nothing yet, and deliberately so

A cartesian product over an edge’s own values is a bound stated in the data’s own
units, which [ADR 12](./0012-bound-memory-by-the-unit-of-work-not-the-input.md)
says is not a bound. Fan-out therefore needs one, and **this decision does not
supply it**.

An earlier draft capped the entries a document may store (`maxEntries`, default
100). That was the wrong place, for a reason worth recording: by the time the
projection runs, every cost has already been paid. The CONSTRUCT matched those
values and the endpoint paid for it, they crossed the wire, the subject index
holds them, and framing has materialised them into one node. Capping the
_product_ declines the last and cheapest step while keeping all the expensive
ones – and it bounds nothing that framing did not already hold.

The bound belongs where the data enters memory. Capping values **per leaf** at
the framing seam bounds the framed node itself, and makes the product
`k^(weldable leaves)` – leaf count is a schema constant, so that is a bound in
the schema’s own units rather than a number written against the data’s. It also
bounds the linear case an entry cap never addressed: a wide edge, or a
display-only nesting of ten thousand entries, both of which predate fan-out and
are equally unbounded today.

That belongs to the framing seam, which serves every consumer rather than this
one, and wants its own evidence and its own record. Tracked in
[#826](https://github.com/ldelements/lde/issues/826).

**Until then the fan-out is unbounded**, exactly as the entry list it replaces
always was. What changed is that the growth can now be multiplicative rather
than linear, which is why the bound is worth doing rather than assuming.

## Consequences

**The weld works on the engine we run.** No release to wait for, no release
candidate in production.

**It costs nothing to upgrade later.** Measured at 1 000 000 documents, both end
states are the same speed, and the fanned-out shape is no slower on 31.0 than the
array shape it replaces:

|                          | welded filter, p50 | role alone | facet |
| ------------------------ | ------------------ | ---------- | ----- |
| 30.2 + fan-out           | 14–19 ms           | 15.9 ms    | 30 ms |
| 31.0 + arrays            | 13–16 ms           | 15.8 ms    | 64 ms |
| 30.2 + arrays _(before)_ | **hangs**          | 15.8 ms    | 30 ms |
| 31.0 + fan-out           | 13–16 ms           | 16.1 ms    | 28 ms |

So this is not a trade the 31.0 upgrade unwinds. When 31.0 goes stable it is
routine maintenance, not a migration back.

**Indexing is ~15 % slower** – 54 s against 47 s for 1 000 000 documents,
consistent across both engine versions – because a document carries about 50 %
more entries. A batch cost, not a request cost.

**Filters and facets stay on the real fields.** The alternative that also works on
30.2 is to weld at index time into a composite `role|agent` key and filter it with
one condition. It is faster (3 ms against 17 ms) and worse: at 1 000 000 documents
faceting that key yields 2 142 125 buckets in 1.4 s, against 15 buckets in 48 ms
for the role itself. It also needs a separator that can never occur in an IRI, and
forces the schema to declare which pairs are weldable, narrowing the query surface
from _any two edge fields_ to _the declared pairs_. Rejected.

**A schema that declared a weldable leaf `array: true` now fails at startup**, with
a message saying to fan out instead. We are pre-release; there is no migration.

**One array-valued weldable leaf re-arms the hang**, which is why part 1 is a
refusal rather than a convention. A deployment cannot opt out of it by accident,
and the failure is at startup rather than a query that never returns.

**A companion’s declared type follows its path, not the leaf.** The flat id a
weld actually names holds one value per entry, but its declared type describes
the whole path across the document: `string[]` under an `object[]` edge,
`string` under a single-valued one. Typesense enforces that strictly wherever
nothing widens the path – a companion declared `string[]` under a single-valued
edge fails the import outright, for every document carrying such an edge. This
is not visible in a collection definition, only against a live engine, which is
why the integration test asserts the import rather than the declaration.

**A single-valued edge still cannot be welded on 30.2.** Where the reference is
not `array`, the stored parent is `object` rather than `object[]`, and the
engine hangs on `credit.{…}` over it whatever the leaves hold – so this is not
the array defect above and fan-out does not address it. It costs nothing today:
a qualified relation is multi-valued by nature and every real edge declares
`array: true`, which is the shape [ADR 24](./0024-carry-data-on-a-reference-edge.md)
describes. A deployment that genuinely wants one qualified edge per document
should still declare it `array: true` and rely on the entries, until 31.0 is
stable.
