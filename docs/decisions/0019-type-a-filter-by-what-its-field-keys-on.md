# 19. Type a filter by what its field keys on

Date: 2026-08-13

## Status

Accepted

Amends [ADR 4 (Search API GraphQL surface)](./0004-search-api-graphql-surface.md);
implements the `idOnly` reference strategy forward-declared in
[ADR 3](./0003-search-api-core-query-model.md) and
[ADR 11](./0011-decouple-rdf-depth-from-the-api-surface.md); completes the
consumer half of [ADR 18](./0018-filter-across-several-fields-with-one-clause.md).

## Context

ADR 18 settled how a consumer states “everything referencing this IRI” – a
cross-field `or` of `@oneOf` criteria. It settled the **mechanism** and left the
**vocabulary** to the client: which fields belong in that `or` list.

ADR 4 pointed every `filterable` keyword and reference field at one shared
`StringFilter`, so introspection could enumerate a criterion’s fields perfectly
and still not tell that `creator` and `material` want IRIs while `identifier`
wants an accession number. The predicate list had to be hardcoded per deployment
and drifted whenever a reference field was added. The consuming clients are
**generic** – they know no domain profile and must not need one – so whatever
answers this has to be reachable by the introspection query they already send.

## Decision

A filter input is typed by what its field keys on: `KeywordFilter` for literals,
`IRIFilter` and per-target `‹Target›Filter` over a new `IRI` scalar for identity,
with `‹Type›Where.id` typed self-referentially so a collection resolves to the
filter type accepting its IRIs. The two discovery strategies this affords are
described in
[the package reference](../reference/search-api-graphql#finding-which-fields-accept-an-iri);
what follows is only what the shape cost, and what it was chosen over.

### The coarse strategy is exhaustive; the refined one narrows

The two strategies do not carry the same guarantee.

**Coarse is complete.** Every field keying on identity takes an `IRI`, so
selecting the criterion fields whose `in` element is `IRI` returns all of them.

**Refined returns a subset.** A reference declares **one** `ref.typeName` and one
`labelSource` – no list form, since the field emits one reference type and
resolves labels from one collection. Where the data admits several classes as
referent, the declaration names one and nothing records the rest. So asking
“which fields could hold an IRI of type X?” returns the fields that **declare**
X, not those that may also **hold** one.

Admitting a list of targets would multiply the emitted types and label sources
for every such field, to answer what coarse already answers. Refinement is a
precision tool, not a completeness claim – and unavailable where the target is
not a root type, since there is no `‹Target›Where.id` to resolve through. Both
limits are in
[the package reference](../reference/search-api-graphql#finding-which-fields-accept-an-iri).

### `kind` is the discriminator, because `idOnly` now exists

The obvious derivation – `reference` means IRI, `keyword` means literal – was
wrong on the fields that mattered most, and a declaration-level marker
(`iri: true` on a `keyword`) was the proposed fix. It was rejected.

The reason those fields were `keyword` was never that they held literals. It was
the **output shape**: `output` on a `reference` requires `ref`, and `ref` gave
the `{ id, label }` object when what the deployment wanted was a flat list of
IRIs. So a `reference` internal field laundered the IRIs and a `keyword` `derive`
surfaced them – a pattern the first deployment to hit this carried over half a
dozen times.

**`idOnly` replaces that pair only where the values are selection keys.** A
canonical vocabulary URI or a licence is one, and typing it `IRI` states a fact.
A **locator** is not – a content or thumbnail URL, a landing page, a manifest to
dereference. Nothing selects on those, they carry no filter or facet, and `IRI`
would assert a selection key that does not exist. They keep the
internal-reader-plus-`keyword` pair, still the only declaration yielding a plain
`String` over an IRI-valued path.

So the split is per property, and the pattern that makes those pairs look alike
does not decide it – in that deployment they divide about evenly. A reader who
collapses every pair on sight retypes locators as identity, and a filter typed
`IRI` over a thumbnail URL is a promise nothing keeps.

Implementing `idOnly` removes the reason instead of working around it. The marker
would have added a concept every deployment author reads, to serve two fields,
while leaving every pair standing and `kind` a non-discriminator. `idOnly` adds
no concept – it was forward-declared in ADR 3 and already documented as “the
IRI”.

### `IRI` validates in both directions

Rejecting a bare token on input is **caller-input validation**, which this
surface already owns: `argsToQuery` rejects an out-of-range `perPage` rather than
letting it reach the engine, because a malformed input should produce an error
naming the problem, not a silent wrong answer.

It validates on the way **out** too. A type enforced in one direction only is not
a type a consumer can rely on, and the coarse discovery strategy reads `IRI` as
precisely the promise that a value is a selection key: serving a non-IRI under it
would falsify the promise exactly where a consumer acts on it, by feeding a
facet bucket back into the filter that is supposed to select it.

**What a bad value costs depends on what it is.** Where the value is the
document’s identity – `id`, a reference’s `id` – raising is right: the document
cannot be selected at all, so serving it hands back something unusable. Where it
is a facet bucket, raising is wrong, and not by a little: `value: IRI!` sits
inside `[IRIBucket!]!` inside `Facets!` inside `‹Type›SearchResult!` inside a
non-null root field, so a raising coercion nulls the **whole response** and takes
`items` and `pagination` with it.
[ADR 5](./0005-batch-facet-queries-through-the-engine-port.md)’s degradation
contract exists to stop a supplementary sidebar count doing exactly that – it
degrades a failed facet to an empty list precisely so the response survives. So
the facet resolvers filter
unselectable buckets out instead – a bucket that cannot be sent back as the
filter selecting it is not a bucket worth serving, and dropping it keeps the
promise without the collateral.

That leaves the outbound error reachable only from an index written before the
projection guard existed – which a reindex fixes. For that to be true the guard
has to cover **every** route a reference value can take, not just the graph path:
`iriString` covers the path, and `applyFacet` and the `derive` branch of
`applyField` cover `from` projection values, `transform` results and derived
values. Missing any of them would leave the surface promising `IRI` over
something the projection had let through – and the conversion this ADR
prescribes, `keyword` `derive` → `kind: 'reference'`, routes straight through
the busiest of them.

The check is a **scheme check, not an `http(s)` one**. `urn:`, `doi:`, `ark:`,
`tag:`, `mailto:` and a deployment’s own minted scheme are ordinary Linked Data;
rejecting them would refuse conformant data to catch a class of mistake a weaker
rule catches anyway.

### Blank-node referents stop being indexed

Validation is only sound if the index cannot hold what the surface refuses, and
`kind: 'reference'` did **not** guarantee an IRI: a profile-admitted blank-node
referent projected as `_:b0`, which a facet would then offer and the filter
refuse. `isAbsoluteIri` therefore lives in `@lde/search` and is applied by the
projection as well, so the two cannot disagree.

What a `labelOnly`/`idOnly` reference stores is a **selection key**, and a
framing-minted label is not one: it recurs across documents and changes when
unrelated triples do, so a bucket keyed on it neither groups what is equal nor
separates what is not. An **inline** reference is untouched – it carries the
referent’s fields rather than its identity, so a blank-node referent nests
exactly as before, which ADR 11 depends on.

## Consequences

- A generic consumer builds ADR 18’s cross-field `or` from introspection, and the
  hardcoded per-deployment predicate list disappears. The cost is paid once in
  each deployment’s declaration instead of once per consumer.
- **Breaking.** `StringFilter` is gone, `id` filters are per-type, and a variable
  must be declared `[IRI!]` rather than `[String!]` – GraphQL checks variable
  usage nominally, though the two are identical on the wire. `Type.id` and
  `‹Type›Reference.id` are `IRI!`.
- A deployment declaring an IRI-valued field as `keyword` now mis-declares it
  visibly. The fix is `kind: 'reference'`, which no longer costs it the flat
  output shape.
- Blank-node referents disappear from `labelOnly`/`idOnly` reference fields.
  Where a deployment needs them addressable, the answer is upstream – skolemize
  in the graph, so the referent and every reference to it are rewritten together.

## Rejected

**An output-side `Reference` interface**, implemented by every `‹Type›Reference`
so one fragment renders any reference field. Its premise is false: the reference
types are not structurally identical. An inline type’s `id` is nullable _by
design_ – a referent needs no identity (ADR 11) – and it carries the referent’s
own `output` fields, which need not include a `label`; `idOnly` is not an object
at all. Narrowed to `labelOnly` types it becomes buildable and still does not
earn its place: a generic client is already introspecting to build the `or` list,
so it can read `id`/`label` off each reference type structurally, and its queries
are generated per deployment regardless. One shared fragment versus several
generated ones is a difference paid by a code generator, not a reader.

**An input-side interface.** `input TermFilter implements Reference` cannot be
expressed: interfaces and unions are output-only in GraphQL, because abstract
types resolve at execution time and that has no meaning for a value the client
supplies. `GraphQLInputObjectTypeConfig` accordingly has no `interfaces`, and
input interfaces remain an unaccepted RFC. The `IRI` scalar is the input-side
abstraction instead – the shared supertype across `TermFilter`, `PersonFilter`
and `IRIFilter`, tested structurally on `in`’s element type rather than
nominally. Deliberately not named `Reference`, since `‹Type›Reference` already
owns that word on the output side: `IRI` names the value, `Reference` the role.

**Keeping one `ValueBucket`** whose `value` is a `String` whatever the facet
keys on. It saves a consumer one bucket type to learn, but it puts a
`String`-to-`IRI` boundary in the middle of the round trip this ADR exists to
make typed: a consumer reads a bucket `value` and sends it straight back as the
`‹Target›Filter` that selects it, and GraphQL checks variable usage nominally,
so the two halves would not compose without a cast. `BooleanBucket` already
resolves this the other way – it serves a real boolean so the bucket feeds `is`
directly – and a reference facet has the same claim. Hence `IRIBucket`, built
from the same field factory as `ValueBucket` so the two cannot drift.
