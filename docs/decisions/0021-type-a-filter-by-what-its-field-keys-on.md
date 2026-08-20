# 21. Type a filter by what its field keys on

Date: 2026-08-13

## Status

Accepted

Amends [ADR 4](./0004-search-api-graphql-surface.md); implements the `idOnly`
strategy forward-declared in [ADR 3](./0003-search-api-core-query-model.md) and
[ADR 11](./0011-decouple-rdf-depth-from-the-api-surface.md); completes the
consumer half of
[ADR 18](./0018-filter-across-several-fields-with-one-clause.md).

## Context

A consumer showing one entity wants everything connected to it – and the
connections run through different fields: a work is _about_ a term, another is
made _of_ it, a third was made _by_ a person of that name. Answering in one query
means naming every field the link could run through.

ADR 18 settled how a consumer states that – a cross-field `or` – and left the
**vocabulary** to the client: which fields belong in that `or`.

ADR 4 already typed a filter by its field where the operator differed (ranges
for the numeric kinds, a plain `Boolean` for booleans) but pointed every
`filterable` keyword **and** reference field at one shared `StringFilter`, so
introspection could enumerate a criterion’s fields and still not tell which of
them take IRIs. The list had to be hardcoded per deployment, and drifted
whenever a field was added. Consuming clients may be **generic** (domain-agnostic), so the
answer has to be reachable by a dynamic GraphQL introspection query.

## Decision

Add an `IRI` scalar, and give each `filterable` field a filter input typed by
what that field keys on:

- `KeywordFilter` – literals;
- `‹Target›Filter` – an IRI keying a document in a collection this API serves;
- `IRIFilter` – an IRI keying nothing here, such as an external vocabulary URI
  or a license.

Every `‹Target›Filter` is the same shape – `{ in: [IRI!] }` – and matches the
field against those IRIs, nothing more. They are separate types only so their
**names** differ, which is what a consumer groups fields by; reaching into a
referent is a join ([ADR 19](./0019-filter-across-collections-through-declared-joins.md)),
not this.

Each root type’s own `id` takes that same filter – a deployment declaring `Term`
gets `TermWhere.id: TermFilter` – so a consumer that queried one root field can
find the filter type its IRIs go in, and every field elsewhere accepting them.
The name is the deployment’s, not this package’s: a consumer tests two of them
for equality and never reads meaning into one, which is what lets a client with
no domain profile do this at all.

Two discovery strategies follow from that. The
[`@lde/search-api-graphql` reference](../reference/search-api-graphql#finding-which-fields-accept-an-iri)
gives their queries and calls them coarse and refined.

### One sweep is complete, the other returns a subset

Both answer the same question, i.e. which fields go in ADR 18’s `or`, and differ
in what they promise.

The coarse one takes every criterion field whose `in` element is `IRI` – all of
them, since that is what keying on identity means. A consumer holding an IRI of
unknown type puts the lot in the `or`; the fields that cannot match it are still
evaluated and return nothing, so breadth costs disjuncts, not correctness.

The refined one instead resolves the root type in hand to its filter type –
through that type’s own `id` – and takes only the fields carrying it. It narrows
because a reference names **one** target and there is no list form: the field
emits one reference type and resolves through one collection. Where the data
admits several classes as referent the declaration still names one, so refined
returns the fields that **declare** a type, not those that may also hold one – a
precision tool, not a completeness claim. It is also unavailable where
the target is not a root type, since there is no `‹Target›Where.id` to resolve
through.

### `kind` is the discriminator, because `idOnly` now exists

The fields that broke the obvious derivation – `reference` means IRI, `keyword`
means literal – were never `keyword` because they held literals, but because of
the **output shape**: `output` on a `reference` required `ref`, which gave an
`{ id, label }` object where the deployment wanted flat IRIs. So an internal
`reference` laundered them and a `keyword` `derive` surfaced them.

`idOnly` removes that reason rather than working around it: it surfaces the IRI
alone, the pair collapses, and `kind` discriminates after all.

### `IRI` validates in both directions

Rejecting a bare token on input is caller-input validation this surface already
owns. Outbound matters too: a type enforced one way only is not one a consumer
can rely on, and coarse discovery reads `IRI` as the promise that a value is a
selection key.

**What a bad value costs depends on what it is.** For identity – `id`, a
reference’s `id` – raising is right: the document cannot be selected at all. For
a facet bucket it is wrong. `value: IRI!` sits inside non-nulls up to the root
field, so raising nulls the whole response and takes `items` with it, which
[ADR 5](./0005-batch-facet-queries-through-the-engine-port.md)’s degradation
contract exists to prevent. Unselectable buckets are dropped instead.

That leaves the outbound error reachable only from an index written before the
projection guard, which a reindex fixes – provided the guard covers **every**
route a reference value takes: the graph path, `from` projection values,
`transform` results and derived values. The check is a **scheme** check, not an
`http(s)` one: `urn:`, `doi:`, `ark:` and a deployment’s own minted scheme are
ordinary Linked Data.

### Blank-node referents stop being indexed

`kind: 'reference'` did **not** guarantee an IRI: a profile-admitted blank-node
referent projected as `_:b0`, which a facet would offer and the filter refuse.
`isAbsoluteIri` therefore lives in `@lde/search` and the projection applies it
too: a framing-minted label is no selection key, recurring across documents and
changing when unrelated triples do. An **inline** reference is untouched: it
carries the referent’s fields rather than its identity, which ADR 11 depends on.

## Consequences

- A generic consumer builds ADR 18’s `or` from introspection, not from a
  hardcoded per-deployment predicate list.
- **Breaking.** `StringFilter` is gone, and where every type’s `id` once took
  that one shared input, each now takes its own target filter – `TermWhere.id` is
  a `TermFilter`. A fragment that filtered `id` across several collections no
  longer typechecks against all of them.
- A client that passed its IRIs through a `[String!]` variable has to redeclare
  it as `[IRI!]`: GraphQL matches a variable to the input it feeds by type name,
  so `[String!]` is rejected where `[IRI!]` is expected. Only the declaration
  changes – both send the same JSON string.
- A deployment declaring an IRI-valued field as `keyword` mis-declares it
  visibly. The fix is `kind: 'reference'`, which no longer costs it the flat
  output shape.
- Blank-node referents disappear from `lookup`/`idOnly` fields. Where they must
  be addressable, skolemize upstream.

## Rejected

**A declaration-level marker** – `iri: true` on a `keyword`, to say its values
are IRIs after all. It annotates around the problem instead of removing it: every
internal-reader-plus-`keyword` pair stays, `kind` stays a non-discriminator, and
every deployment author gains a concept to serve the few fields that carry it.
`idOnly` costs no concept – it was forward-declared in ADR 3 – and deletes the
pairs outright.

**A list of targets per reference**, so a field admitting several classes could
declare them all and refined discovery would stop under-reporting. It multiplies
what one declaration decides – the emitted reference type, the collection labels
resolve through – for every field that takes one, to answer a question coarse
discovery already answers completely.

**An output-side `Reference` interface.** The reference types are not
structurally identical: an inline type’s `id` is nullable by design (ADR 11) and
carries no guaranteed `label`, and `idOnly` is not an object at all. Narrowed to
`lookup` types it is buildable but unearned – a generic client already
introspects and generates its queries per deployment, so one shared fragment
versus several generated ones is paid by a code generator, not a reader.

**An input-side interface.** Interfaces and unions are output-only in GraphQL:
abstract types resolve at execution time, which has no meaning for a value the
client supplies. The `IRI` scalar is the input-side abstraction instead – the
shared supertype across the filter inputs, tested structurally on `in`’s element
type. Deliberately not named `Reference`, since `‹Type›Reference` owns that word
on the output side: `IRI` names the value, `Reference` the role.

**One `ValueBucket` for every facet.** It saves a consumer one type to learn, but
puts a `String`-to-`IRI` boundary in the middle of the round trip this ADR exists
to make typed: a bucket `value` sent back as the filter that selects it would not
compose without a cast. `BooleanBucket` already serves a real boolean for the
same reason. Hence `IRIBucket`, built from the same field factory as
`ValueBucket` so the two cannot drift.
