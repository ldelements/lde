# 27. Resolve a reference across several targets

Date: 2026-09-10

## Status

Accepted

Extends [ADR 20 (Resolve a reference’s fields from the target’s own collection)](./0020-resolve-a-references-fields-from-the-targets-own-collection.md),
whose `lookup` names one target, and
[ADR 24 (Carry data on a reference edge)](./0024-carry-data-on-a-reference-edge.md),
whose `local` lookup stores a referent through that one target’s declaration.
Amends [ADR 21 (Type a filter by what its field keys on)](./0021-type-a-filter-by-what-its-field-keys-on.md),
which rejected two of the things decided here. Leaves
[ADR 19 (Filter across collections through declared joins)](./0019-filter-across-collections-through-declared-joins.md)
untouched, and states what it cannot reach.

## Context

SCHEMA-AP-NDE ranges `CreativeWork.creator` over `Person` **or**
`Organization`. A `lookup` names one `target`, so a deployment declared
`target: 'Person'` and got exactly half of the field: every person labelled and
typed `PersonReference`, every organization unlabelled and _also_ typed
`PersonReference`. Measured on the reporting deployment’s facet, the split was
exact – seven labelled values, all persons; three null, all organizations. A
consumer routing a click on `creator.id` to a person page followed it for an
organization and landed nowhere, with nothing in the response to warn them.

Two things have moved since the issue was filed. First, the declaration now
sits **inside an edge**: `creator` is an inline `CreatorRole` carrying the role
a publisher wrapped the agent in, and the polymorphic lookup is the edge’s
nested `creator`, reached through `identity`. Second, `local: true` stores
what the work states about its creator, so an organization is no longer
_unlabelled_ – the referring document names it. That narrowed the defect to
two things a label mechanism can never fix: the facet buckets, still labelled
through the single target, and `__typename`, still claiming `PersonReference`.

Retargeting is not a workaround. Pointing `creator` at the type most referents
are co-typed with (`Term`, in that corpus) took the facet from seven labelled
values to five. No single target covers a range the profile itself declares as
a disjunction.

ADR 21 had rejected both a list of targets per reference and an output-side
interface, on the grounds that coarse discovery already answered the input-side
question and that a shared fragment was “buildable but unearned” on the output
side. Both grounds were about convenience. A type claim that is false for half
the values is not a convenience problem.

## Decision

### A lookup names several targets, in order of precedence

`target` – and an `idOnly`’s `labelSource` – accepts a `string` or a
`readonly string[]`. One reading serves both: a single name is the list of
one, and no consumer branches on which it was given. Every named type must be a
Root Type with a label field; a name declared twice is rejected; `joinable` is
refused when there is more than one (below).

**Declaration order is precedence.** A referent two collections hold – two
Root Types whose `class` selections overlap – belongs to the first target
declared. So does a stored referent whose `rdf:type` matches none of them. The
rule is per value: one field serves persons and organizations side by side.
Precedence is declaration order rather than an option because it is the only
lever an author already has, and because overlap is the author’s own choice –
two Root Types selecting overlapping classes is legal for facets and joins
already, and silently choosing is what the rest of the system does.

### Each referent is read through the target it belongs to

Three declarations flow through _naming the target_: the label field, the
document key ([ADR 22](./0022-key-a-root-type-on-a-declared-field.md)) and the
facet policy. The reporting deployment’s two targets disagree on the one that
changes what is stored – `Person` is keyed on an authority IRI, `Organization`
on nothing – so requiring the targets to agree would reject the schema the
issue came from.

Each referent is therefore treated as a document of whichever target it
matches: re-keyed through that target’s key, admitted to a facet by that
target’s policy, labelled from that target’s collection. Nothing changes for
the targets themselves; `Person` keeps its key without knowing it appears in a
polymorphic lookup. The interface an author learns is one sentence longer than
before, which is the point of doing the dispatch per entry rather than
demanding alike targets.

### A stored referent carries a discriminator

A `local` lookup stores what the referring document states, and in the
reporting corpus seven creators in eight are never identified. No collection
will ever answer for them, so the collections cannot be the only evidence of
kind. The extraction reads the referent’s `rdf:type` – one `OPTIONAL` triple
per referent, emitted as `rdf:type` itself so framing carries it as `@type` –
and the projection matches it against each target’s `class` in declaration
order. The entry is projected through the matching declaration and records
which under the reserved physical name `_target`, which no type may declare.

That discriminator is also what re-keys the entry and admits it to a facet, so
the three readings cannot disagree. An engine adapter reads it back when no
collection answers, so an unidentified organization is served as an
organization. A single-target lookup stores none: there is nothing to tell
apart.

The nested object an engine declares is the union of the targets’ fields, so
two targets declaring one field must declare it alike – same kind, same arity,
same Roles, and for a reference the same strategy and referent – since every
one of those decides the field’s physical shape, and a shape that depended on
which target was listed first would store one target’s referents wrongly.
`searchSchema` rejects the pair otherwise; a field only one target declares is
fine, the other simply never fills it. This holds for a `local` lookup today
and for every lookup once
[#818](https://github.com/ldelements/lde/issues/818) drops the flag, which is
why the multi-target projection lives in the shared nesting body rather than
behind a `local`-specific switch.

### The surface serves an interface, and a filter named for the set

A GraphQL surface serves a lookup naming several targets as an **interface**
named for the set in declaration order – `PersonOrOrganizationReference` –
implemented by each target’s own `‹Target›Reference`. Two fields naming the
same targets share one interface, exactly as two lookups on one target share
one reference type ([ADR 20](./0020-resolve-a-references-fields-from-the-targets-own-collection.md)).
The name is derived, not declared: no new option, and the same mechanism that
derives `‹Target›Reference`.

The interface carries only what is true of every referent: `id`, nullable if
any member’s is, and every `output` field all targets declare alike, with the
weakest nullability any of them keeps – an implementation may promise more than
its interface, never less. Per-type fields stay on the members, reached
through an inline fragment. `__typename` resolves per referent to the target
whose collection answered for it, or, for a stored referent no collection
answers for, to the target its discriminator names. The port marks each nested
document with that target under a symbol key, so the mark can never collide
with a declared field. A bare IRI no collection holds is the one referent with
no kind to report; an interface must still resolve to some object type, so it
is served as the first target declared.

An interface rather than a union, because union members share no fields, so
even `creator { id name }` would need a fragment and every existing consumer
would break. An interface keeps that selection working unchanged. A `type`
scalar on a flat reference was rejected in the issue for a reason that still
holds: the moment a reference carries more than a label, per-type fields have
nowhere to live.

On the input side, the field’s filter is named for the set too –
`PersonOrOrganizationFilter { in: [IRI!] }` – rather than for the first target,
which would lie about half the values, or `IRIFilter`, which would claim the
ids belong to no collection here. ADR 21’s coarse discovery still finds it,
since its element type is `IRI`. Refined discovery, which resolves through one
target’s own `id`, does not reach it; ADR 21 already called refined “a
precision tool, not a completeness claim” and named polymorphic ranges as
where it under-reports. This makes the under-report visible in the name.

### No join

A reference naming several targets refuses `joinable`. An engine reference
names one collection, and ids that live in several have no single collection
to reference. Its labels, facets and id filters all work from the referring
document. What stays out of reach is a **join predicate** – a condition on the
referent’s own fields, “works whose creator died before 1900”. The issue lists
three ways to recover one (a shared collection of the common fields; the same
collection denormalised to the union of fields with a discriminator; one
reference field per target disjoined at query time), none needed for what this
record delivers and each costing a second copy of every agent or two
unverified engine behaviours. Deferred, to
[#845](https://github.com/ldelements/lde/issues/845) and a record of its own.

## Consequences

- A field whose referent may be of several kinds labels every value, types
  every value truthfully, and serves each kind’s own fields through a fragment.
  Facet buckets are labelled from whichever collection holds the value.
- **Breaking** for a schema-level reader: `labelSourceNameOf` and
  `labelTargetNameOf` become `labelSourceNamesOf` and `labelTargetNamesOf`,
  returning a list; `localLookupTypeOf` becomes `localLookupTargetsOf`;
  `inheritedFacetKeys` becomes `inheritedFacetPolicies`, keyed by target. A
  declaration naming one target is unchanged, stores what it stored, and emits
  the GraphQL it emitted.
- A multi-target lookup costs one query per target collection per level where
  a single-target one costs one – still one round-trip per level, the queries
  running concurrently – and asks every collection even for a selection
  reduced to `id`, because the answer is what types the referent. Its stored
  entries cost one short string each, and its extraction one `OPTIONAL` triple
  per referent plus every keyed target’s key hop.
- The framing depth of a type nesting a multi-target lookup is the furthest
  any target reaches: the referent is framed once, and the frame has to hold
  whichever declaration it turns out to match.
- `_target` joins `id`, `and` and `or` as a name no type may declare.
- Label precedence is settled **per type**, in the order its fields first name
  the collections: a page’s labels are one map keyed by IRI, so two fields of
  one type ordering the same targets differently cannot each get their own
  answer for an IRI both collections hold. Before, the same overlap was
  labelled by whichever collection answered last – now it is deterministic
  and documented, and the projected lookup (which does resolve per field)
  can disagree with a bucket label only in that corner.
- A declared type may not be named as the joined name of a target set
  (`PersonOrOrganization` beside a lookup over `Person` and `Organization`):
  the interface and the type’s filter would share a name, so the GraphQL
  surface refuses the schema, naming both.
- Amends ADR 21: a list of targets per reference and an output-side interface
  are both accepted, for a reason ADR 21 did not weigh – a type claim that is
  false for half the values. Its input-side reasoning stands: an interface is
  output-only, and the `IRI` scalar remains the input-side abstraction.
