# 24. Carry data on a reference edge

Date: 2026-08-27

## Status

Accepted

Extends [ADR 11](./0011-decouple-rdf-depth-from-the-api-surface.md) (an inline
reference carries a referent’s fields) and
[ADR 20](./0020-resolve-a-references-fields-from-the-targets-own-collection.md)
(a lookup carries the referent’s own document). This ADR lets one field do both.
Relates to [ADR 22](./0022-key-a-root-type-on-a-declared-field.md) and
[ADR 12](./0012-bound-memory-by-the-unit-of-work-not-the-input.md);
[ADR 18](./0018-filter-across-several-fields-with-one-clause.md) and
[ADR 5](./0005-batch-facet-queries-through-the-engine-port.md) are unchanged.

## Context

Sometimes a fact belongs to the _relation_, not to either end of it. A graph
says so by putting a node in between:

```turtle
<work> ex:creator [ ex:qualifier "etcher" ;      # the relation’s own value
                    ex:creator   <person> ] .    # the endpoint
```

That middle node is the **edge**. We could not index it.

An inline reference nests whatever node its path reaches, so it already nests
the edge and its `qualifier`. What it could not do is follow `ex:creator` out of
the edge to `<person>`: a nested field could carry `output` and nothing else,
and a nested `lookup` was refused outright. A lookup is walked level by level
from the hit’s own fields, and a nested document arrives already embedded in its
referrer, so nothing ever descended into one to collect the ids to resolve.

The other strategy has the mirror problem. A top-level `lookup` resolves
`<person>` beautifully and has nowhere to put `"etcher"`.

So a deployment had to drop the qualifier, or carry it in a parallel array that
cannot be paired back to its endpoint.

**A second problem shares the same shape.** Real corpora identify some endpoints
(such as `creator`) with an IRI and name others inline, as a literal or a blank node.
Today that needs two fields – a `reference` for the identified, a `text` field for the
rest, which are again parallel arrays. API consumers see two
fields where they expect one, and reasonably read one as a bug.

Both problems want the same thing: **one entry per edge, holding its own values
_and_ a reference into another collection.**

## Decision

One field, one entry per edge:

```ts
{ name: 'creator', kind: 'reference', array: true, output: true,
  path: '<…/creator>', filterable: true, facetable: true,
  ref: { strategy: 'inline', typeName: 'CreatorEdge', identity: 'creator' } }
```

```json
{
  "creator": [
    {
      "qualifier": "etcher",
      "creator": { "id": "…/rembrandt", "name": "Rembrandt van Rijn" }
    },
    { "qualifier": "author", "creator": { "name": "Jan Jansen" } }
  ]
}
```

Seven mechanisms make that work.

### 1. A nested field may be `filterable` and `searchable`

A field's **capabilities** are what it opts into: `output`, `filterable`,
`facetable`, `sortable`, `searchable`, `joinable`. (The code calls these
_Roles_. This record says _capability_ throughout, because its worked example is
a `schema:Role` – the edge node – and one word cannot mean both here.)

A nested field could previously be `output` and nothing else, because serving
more “would need query-compiler and engine support that no engine port
declares”. Measured against a live engine, that held for two of the four
capabilities, not all four:

| Capability                 | Verdict                                                      |
| -------------------------- | ------------------------------------------------------------ |
| `filterable`, `searchable` | served exactly: now allowed                                  |
| `facetable`                | counts are **document-level**, so they are wrong (see below) |
| `sortable`                 | there is no sorting _into_ an array element                  |

Capabilities stay independent opt-ins, and here that matters more than usual,
because **edges multiply**. A document carries one entry per relation and a
corpus carries millions of documents, so a rule of “nesting means indexing”
would price the whole entry – every qualifier, every name, every id – into
memory, on every edge. Adding a capability for display would then cost the same
as adding one you query.

An engine holds its _index_ in memory and the documents themselves on disk, so
an `index: false` field costs disk and response bytes but no RAM however large
it grows. A nested field declaring only `output` is therefore stored exactly as
before, and only one that opts into a query capability is indexed. A deployment
can nest ten fields for display and index one, and pay for the one.

With one exception worth stating, because it is the one place the cost is not
the referring type's to choose: a `local` lookup
projects its endpoint through the **target's own declaration**, so the target's
capabilities come with it – a `searchable` label on `Person` is indexed inside
every document that nests one. That is what makes free text reach an endpoint's
name, and it is a real cost: nesting a wide target for display alone indexes its
searchable fields per referring document. Nest a target whose capabilities you
are willing to pay for at that multiplicity.

We extend `inline` rather than add a `qualified` strategy beside it. A second
nesting word would make the interface larger, forcing every user to choose
between two and a switch (including rebuild) once a nested field needs a filter.

### 2. A nested reference may be a `lookup`

Resolution already walks a projection level by level. It gains one new kind of
level: an **inline** level, which costs no round trip. It flattens the entries
out of the parent documents and passes them down, so the ids come from the
entries rather than from the document, and the lookup below is batched across
the whole page as any other is.

ADR 20’s bound is untouched – one round trip per _lookup_ level, never one per
document, because descending is free. `ResolvedReferents` becomes a
discriminated union (`via: 'lookup' | 'nested'`) rather than a lookup-shaped
record with two empty fields.

Re-keying needs no new rule: an inline referent goes through the same
`projectFields`, so a nested reference re-keys through its target exactly as a
top-level one does (ADR 22).

### 3. A reference resolves where it can, and nests where it cannot

Such a reference stores the endpoint’s locally-projected fields **always**, and
overlays the resolved document when the lookup succeeds. One field then serves
both populations: an identified endpoint gets its id and the target’s own
fields; an unidentified one gets the fields the referring document states, and
no id.

Always, rather than only when there is no id, because the two failures are
different: at index time the question is _is this endpoint identified_, at query
time it is _is that document indexed_. Storing local fields unconditionally
means an endpoint whose document is missing still shows a name instead of a bare
IRI.

### 4. An inline reference filters and facets through an identity companion

A nested object is not something an engine can filter or facet. So an inline
reference that declares `filterable` or `facetable` fans out a second physical
field, `${name}_id`, holding the ids its entries reference. The engine filters
and facets that instead. `${name}_facet` already established the pattern: one
logical field, two physical fields.

The logical field keeps one name, so a consumer filters and facets on the same
word they read: `where: { creator: { in: […] } }`.

`identity` names which nested reference to harvest. Declared, not inferred – an
edge may carry several references, and only the author knows which one
identifies it. Naming it also supplies the _target_, which is what types the
filter and what a facet policy is inherited through. Both directions are
enforced: `filterable`/`facetable` without an `identity` has nothing to filter,
and an `identity` without either is a companion nothing reads.

The ids are harvested from the entries rather than read from a second path.
A path that reaches the endpoint through the edge (`<…/creator>/<…/creator>`)
also matches the **edge itself** wherever the edge is a named node, which would
file an edge as though it were an endpoint. Harvesting cannot do that.

Because the companion holds ids only, its facet is exact: an unidentified
endpoint contributes no bucket rather than a bucket keyed on a label, so two
endpoints that share a name are never merged.

`joinable` stays refused on an inline reference. The companion is exactly the
flat id field a join would point at, so this is out of scope rather than
impossible.

### 5. Framing depth counts hops, not inline levels

Framing depth used to count inline levels and ignore how far the property paths
_inside_ them reach. A two-step path off a directly-referenced node resolves at
depth 1; the same path off a node reached through an inline reference does not,
and the values it reads are simply missing from the frame. The projection then
stores an un-keyed id that matches nothing, in silence.

Depth now measures the furthest declared value in hops, adding up three things:
path traversal, inline nesting, and the extra hop a keyed target’s document key
needs (ADR 22). It is still one schema-derived constant computed once, so ADR
12’s bound holds – the constant is just slightly larger.

### 6. Conditions inside one edge are welded to one entry

“This endpoint _in this role_” is the question an edge exists to answer, and it
is not the same question as “this endpoint somewhere, this role somewhere”. A
document with Blaeu-as-etcher and Rembrandt-as-painter answers the second and
not the first.

So **every condition inside one edge’s `where` holds of the same entry**:

```graphql
where: { creator: { where: { creator: { in: ["…/rembrandt"] },
                             role:    { in: ["etser"] } } } }
```

One line states the rule: **inside one edge’s `where`, the same entry; across
`and`/`or` clauses, anywhere in the document.** The compact spelling is the
welded one, so what is easiest to write is also what is usually meant.

It stays an **atom** – one criterion carrying its conditions – so ADR 18’s flat
conjunction of disjunctions is untouched and skip-own-filter still finds one
field per clause. `‹Edge›Where` therefore declares no `or`/`and`: a disjunction
inside a weld is not a weld, and the surface rejects it rather than flattening
it into something wider.

Welding an **identity** needs care, because an engine welds conditions on an
entry’s **leaf** fields only. A `local` lookup stores an object, so its id sits
a level too deep – which is why `filterable` on one fans out the same identity
companion an inline reference uses, as a leaf beside the object. The consumer
never sees it: they write the logical field, and the compiler reads the
companion.

### 7. A criterion may address a nested field

`CriterionBase.on` becomes a path of two kinds of hop, resolved from the schema:
a `joinable` reference resolves through the join graph and compiles to a
cross-collection clause; an inline reference resolves to its Reference Type and
compiles to a nested-field clause on the same document. The surface needs no new
vocabulary – a nested `where` already flattens into an `on` path.

Because the kinds differ, `MAX_JOIN_DEPTH` counts join hops only (a nesting hop
costs no round trip and must not spend a budget meant for round trips), and the
`unknown-join` issue splits, so “not joinable” and “not nested” are not reported
identically.

`where` stays the flat conjunction of disjunctions of ADR 18: a criterion on a
nested field is still an atom naming one field.

## Constraints verified against Typesense 30.2

Checked against the docs and a live `typesense/typesense:30.2` container.

| Behaviour                                                 | Result                                                    |
| --------------------------------------------------------- | --------------------------------------------------------- |
| Index one nested sub-field, leave siblings `index: false` | Works; unindexed siblings still returned                  |
| Free text (`query_by`) over a nested field                | Works, at nesting depth 1 and 2                           |
| Exact membership on a nested field                        | Works, at both depths                                     |
| Filter an `index: false` field                            | Fails **loudly**: `Cannot filter on non-indexed field …`  |
| `index: false` on the parent `object[]`                   | **Silently** disables every child’s indexing              |
| Facet a nested sub-field                                  | Counts are **document-level**                             |
| Weld conditions on an entry’s leaf fields (`p.{a && b}`)  | Exact                                                     |
| A **dotted path** inside a weld (`p.{a.b:=…}`)            | **Hangs** – no error, no result, the connection times out |

Three of these decide the design.

**The hang.** A dotted path inside a group does not fail, it never returns – so
the compiler must be structurally incapable of emitting one rather than merely
avoiding it. Every welded condition is compiled against the reference type with
an empty prefix, which makes a leaf name the only thing that can appear there.

**The parent-object trap.** With the parent `object[]` unindexed, indexed
children are ignored and every query returns empty – no error. The collection
builder must never emit that combination.

**Document-level facet counts.** A filter scoped to one array element does not
scope the facet. Pin one sub-field and the facet over a sibling sub-field still
counts every element of every matching document, including the elements that did
not match. There is no element-scoped facet syntax. That is why `facetable` is
refused on a nested field, and why the identity companion – an ordinary flat
field – is how an edge gets faceted.

## Consequences

- One field states a qualified relation: an entry per edge, carrying its own
  values and resolving a reference into another collection.
- One field serves identified and unidentified endpoints together, removing a
  pair of fields that could not be paired.
- **The facet undercounts.** It is keyed on identity, so a document whose
  endpoints are all unidentified contributes to no bucket and the buckets do not
  sum to the result count. Inherent – what has no identity cannot be counted by
  identity – and belongs in the field’s `description`, which surfaces on both the
  output field and the `where` key.
- **A displayed name may not be the name a filter matches.** Nested fields are
  indexed as the referring document states them; the resolved document carries
  the target’s own. Where a target is enriched from an authority the two differ
  systematically: the surface shows the authoritative value, the exact filter
  matches the stated one. Free text covers the gap; a second index does not earn
  its cost.
- Framing pulls one more hop where a schema declares a path reaching past an
  inline referent. Measured across batch sizes, that costs 1.16×–1.47× and stays
  flat per root. A large directly-referenced node dominates the cost, and is
  already paid at the shallower depth.
- Additive: a declaration that opts into nothing new is stored, indexed and
  served exactly as before.

### Out of scope, deliberately

- **Faceting an edge’s own values.** Not servable on this engine, and servable on
  one with element-scoped aggregation. An engine gap, revisited per adapter.
- **Ordering entries.** The container is ordered end to end, but nothing upstream
  puts meaning in that order, so a document needing one must state it on the
  edge.
