# 19. Filter across collections through declared joins

Date: 2026-08-10

## Status

Accepted

Amends
[ADR 18 (Filter across several fields with one clause)](./0018-filter-across-several-fields-with-one-clause.md)
– a criterion gains an `on` path – and weakens
[ADR 9 (Route a whole-schema projection to per-type collections)](./0009-route-a-whole-schema-projection-to-per-type-collections.md)
– the unit of isolation becomes the join component rather than the collection.
Builds on the reference model of
[ADR 8 (Resolve reference labels from per-reference label sources)](./0008-resolve-reference-labels-from-per-reference-label-sources.md).

## Context

“Every object published by institution X” had no answer in one query. Each root
type owns its own collection ([ADR 9](./0009-route-a-whole-schema-projection-to-per-type-collections.md)),
and a `reference` field carried only an IRI, so a consumer had to list the
institution’s datasets, then query the objects of each – two round trips, a
`total` that had to be summed client-side, and facet counts that could not be
computed at all.

The fact needed to close that gap was already declared. A `reference` field
whose `labelSource` names a root type asserts that its values are ids of
documents in that type’s collection – exactly what an engine-level reference
field needs. In [limburg/lol](https://codeberg.org/limburg/lol),
`CreativeWork.dataset → Dataset.publisher → Publisher` is two such assertions in
a row.

What was missing was permission to use them that way, and a home for the rules
that come with using them.

## Decision

### `joinable` is a capability flag, not a reinterpretation

A `reference` field opts in with `joinable: true`, valid only alongside
`labelSource`. It joins `filterable` / `facetable` / `sortable` – the same
vocabulary, the same shape: a field carries exactly the roles it declares.

Auto-deriving a join from every `labelSource` was rejected. Typesense silently
refuses to index a mutual reference, so an existing schema would lose a field
with no error – and every `labelSource` added for display alone would start
paying the rebuild coupling below. As it is, a `labelSource` costs what it
costs today; only an opted-in edge pays.

**At most one `joinable` field per (type, label source)**, enforced when the
schema is built and naming both fields. Typesense addresses a join by
_collection_, not by field: a second reference to the same collection is
accepted, indexed, and then unreachable (see [Constraints](#constraints-verified-against-typesense-302)).
`publisher` and `creator` both resolving to `Organization` is the ordinary case,
so it has to be a declaration error rather than a surprise at query time.

### One concept holds the edges: `joinGraph(schema)`

`joinGraph` has two members, because consumers ask exactly two questions:

```ts
interface JoinGraph {
  readonly components: readonly (readonly RootType[])[]; // which rebuild together
  resolve(from: SearchType, path: readonly string[]): RootType | undefined; // what a path reaches
}
```

It hides edge derivation from `joinable` + `labelSource`, the uniqueness rule,
cycle rejection, the depth cap, and one asymmetry worth naming: component
**membership** is the _undirected_ connected component (a referrer and its
referent rebuild together whichever way the edge points), while the order
**within** a component is the _directed_ topological sort (a collection cannot
be created before the one its reference names).

`searchSchema` builds it eagerly, so a schema whose joins do not hold up fails
at startup rather than on the first query or halfway through the first rebuild.

`resolve` returns a `RootType`, never a collection name. How a type is named in
an engine is engine- and deployment-specific, and stays in the adapter.

### The criterion carries the path

```ts
{ on: ['dataset', 'publisher'], field: 'id', in: ['X'] }
```

`on` is a **path of field names**, not boolean structure, so the criterion stays
an atom and [ADR 18](./0018-filter-across-several-fields-with-one-clause.md)’s
“a criterion can never itself be a conjunction” holds verbatim. `where` is still
a flat conjunction of disjunctions; the nesting lives in each criterion’s path.
Skip-own-filter ([ADR 5](./0005-batch-facet-queries-through-the-engine-port.md))
still scans one level, now keyed by `(on, field)` – a hop out is a different
axis, so a joined clause is no facet’s own.

Putting `on` on the `Filter` was rejected: it would scope a whole disjunction
and make `$publishers(country:=NL) || title:=x` inexpressible.

**Depth is capped at 3**, fixed, and checked in `validateQuery` with a
`join-too-deep` issue. Typesense imposes no limit of its own, and
`graphql-armor`’s max-depth counts selection sets rather than input nesting. The
cap lives in the IR so a later REST surface inherits it.

### The surface makes the capability visible

Per joinable target, one shared input:

```graphql
input PublisherReferenceFilter @oneOf {
  in: [String!]
  where: PublisherWhere
}
```

One per **target**, not per field: what it can express is a property of the
referenced type, so `publisher` and `creator` share it. `in` keeps its meaning –
the ids the field itself holds, no hop – while `where` states a condition on the
referent. `‹Target›Where` is the same input the target’s own query field takes,
so a consumer learns one vocabulary.

A non-joinable reference keeps plain `StringFilter`, so the difference is
visible in the schema rather than discovered from a runtime error.
`whereToFilters` flattens a nested `where` into an `on` path exactly as it
already flattens `and`.

### Reference fields are emitted with all three settings forced

An emitted Typesense reference carries `async_reference: true`,
`cascade_delete: false`, and always targets `.id`. None is a knob:

- without `async_reference`, a document whose referent is not indexed yet is
  rejected with a 400 – and the batch import runs `throwOnFail: false`, so those
  would be **silently dropped documents**. Documents stream per dataset
  ([ADR 13](./0013-project-inside-the-batch-per-root-type.md)), so out-of-order
  arrival is normal, not exceptional;
- `cascade_delete` defaults to `true`, so a sweep removing a departed source’s
  `Publisher` documents would delete other sources’ `CreativeWork` documents
  with them. Disabling it requires `async_reference`, so the two travel
  together;
- a reference match hitting more than one document is also a 400, and `id` is
  the only field the schema guarantees unique.

### The join component is the unit of rebuild

`searchIndexWriter` already opens one run per root type in a single pipeline
run, so this is an ordering and commit change, not new orchestration:

- **open** in topological order, referenced first – an engine cannot create a
  collection whose reference names one that does not exist yet;
- **commit** per component, and within a component sequentially in the reverse
  order, referrers first: a blue/green commit drops the collection it
  supersedes, so committing the referent first would delete a collection the
  still-live referrer’s documents point at. The first failure stops the rest of
  its component from going live, so a component ships whole or not at all.

Locking needs no change: this is still the single deterministic pass that takes
every lock in a fixed order, which is what makes lock-ordering deadlock
impossible.

This weakens [ADR 9](./0009-route-a-whole-schema-projection-to-per-type-collections.md):
the unit of isolation becomes the component rather than the collection. Types
with no joinable edge are singleton components and keep today’s behaviour
exactly, so the weakening applies only where a schema author opted in.

### `collectionNameFor` replaces `name`

The rebuild options take `collectionNameFor: (searchType) => string` instead of
a bare `name`, so a writer can derive a **peer’s** collection name as readily as
its own. That is what a blue/green build needs: Typesense resolves an alias to a
concrete collection at create time and keeps the concrete name, so referencing
the alias would pin a fresh build to the collection the peer is about to
supersede. No coordinator is needed – every writer in a run receives the same
`RunContext`, so `Date.parse(context.startedAt)` is already identical across
them.

### An In-place rebuild fails loudly rather than altering

When a collection exists but lacks a declared reference field, `InPlaceRebuild`
throws with a drop-and-rebuild message. It never alters. `ensureCollectionExists`
only creates on a 404, so without this an existing deployment would index and
commit successfully and then 400 on every join query. Failing keeps the
invariant the component-scoped rebuild rests on: a component’s collections come
into existence _with_ their references, and never acquire them later. Scoped to
reference fields only – every other schema difference is self-correcting, and
general drift detection is a separate feature.

## Consequences

- “Every object published by institution X” is one query with a correct `total`,
  ranking and facet counts: `filter_by: $datasets($publishers(id:=X))`.
- Breaking for `@lde/search-typesense`: the rebuild and collection-definition
  options take `collectionNameFor` instead of `name`.
- Additive for `@lde/search` (`joinable`, `on`, `joinGraph`) and for the GraphQL
  surface (a joinable reference’s input type widens; nothing narrows).
- A deployment that adds `joinable` to a live In-place index must drop the
  affected collections once. That is stated by an error, not discovered from
  failing queries.

### Out of scope, deliberately

- **Reverse joins** – Typesense can search from either side of a reference, but
  the schema has no name for the inverse edge, so the surface would have to
  invent one.
- **Facets on joined fields** – leaves [ADR 5](./0005-batch-facet-queries-through-the-engine-port.md)
  untouched. The `(on, field)` key already anticipates them.
- **Sort through joins** – cheap and symmetric (`Sort` gains the same `on`), but
  the joined per-locale sort key and the many-to-one representative-value
  semantics need their own decision.
- **Free text through joins** – not expressible: a join clause is `filter_by`
  only, with no `q`.
- **Shadow collections** – one materialised join-target collection per edge
  would make `joinable` uniform, but aliases cannot provide it (a reference
  resolves an alias to the concrete collection at create time and discards it),
  so it means real duplicated storage and extra component members. Deferred, and
  unblocked by the API shape: it lives entirely in the collection definition and
  the writer fan-out.

### Documented limitations

- **A reference written while its referent collection is being written
  concurrently can be lost permanently.** This is the sharp one, and it was
  found by the integration test rather than reasoned about. Sequentially,
  `async_reference` is exact: the referrer import is accepted and the reference
  resolves the moment the referent lands (pinned by the reference-back-fill
  test). But per-type stages import into a referring and a referenced collection
  **at the same time**, and in 30.2 a reference written in that window can end
  up never resolved – not delayed, never – with the documents themselves all
  present. Which edge loses varies per run.

  The consequence is that a **single** indexing run does not yet guarantee
  resolved joins for a component built from scratch. A subsequent run does: it
  meets referents that already exist, so every reference resolves at write time.
  A steady-state deployment (daily runs over a mostly-stable corpus) is
  therefore fine; a first build should be run twice. `async_reference` is still
  strictly right – without it those documents would be rejected outright and,
  under `throwOnFail: false`, dropped in silence.

  Not ours to fix, and worth re-testing on every engine upgrade: when it is
  fixed, the second run and this note both go.

- **Only one edge per (type, target type) can be joinable.** Other edges keep
  their labels, facets and id filtering; they just do not gain cross-collection
  filtering.
- **Sibling joined conditions are independent hops.** `dataset: { where: { a, b } }`
  compiles to two criteria, each joined on its own, so under a multi-valued
  reference `a` and `b` may be satisfied by different referents. For the
  single-valued case – the common one – the readings coincide.
- **Blue/green has a brief inconsistency window at the alias flip.** Typesense
  stores the concrete collection name in a reference and re-resolves the alias
  at query time, and there is no atomic multi-alias swap, so a join query can
  see `400 Failed to join on …` for one round trip. Because a component rebuilds
  both sides, we never hit the steady-state form of
  [typesense#2827](https://github.com/typesense/typesense/issues/2827).
- **An unindexed referent is indistinguishable from no value.** A reference
  whose target is never indexed stays unresolved and its document is silently
  excluded from join filters. Normal in linked data, where an IRI may point
  outside the indexed corpus.

## Constraints verified against Typesense 30.2

Checked against the docs, the `v30.2` source, and a live
`typesense/typesense:30.2` container.

- **Joins landed in v26**, not 28. Our containers already run 30.x, so there is
  no version floor to raise.
- **Altering a collection to add a reference field is supported** in 30.x,
  despite the note still on the joins docs page saying otherwise (v30.0 release
  notes; `CollectionJoinTest.AlterReferenceField` passes at v30.2). We do not use
  it – see the In-place decision above.
- **A collection can only be joined through one reference field per target
  collection.** Every join API resolves through a reverse map keyed by
  collection name (`referenced_in`, `include/collection.h:476`), populated with a
  non-overwriting `emplace` (`src/collection.cpp:8540`); the forward check
  discards which field matched (`:8504`). Reproduced live: with `books.author_id`
  and `books.editor_id` both referencing `people.id`,
  `filter_by=$people(name:=Ann)` returns the book, `$people(name:=Bob)` returns
  nothing though the book is edited by Bob, `include_fields=$people(*)` nests
  only the author, and `$editor_id(…)` fails with
  `Referenced collection 'editor_id' not found`. Filed upstream as
  [typesense#3021](https://github.com/typesense/typesense/issues/3021). The docs
  neither promise nor forbid it.
- **Dropping a referenced collection is not blocked** and leaves a dangling
  reference, which is why a component must commit all-or-nothing rather than per
  collection.
