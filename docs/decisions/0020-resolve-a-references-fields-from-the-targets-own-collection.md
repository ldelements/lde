# 20. Resolve a reference’s fields from the target’s own collection

Date: 2026-08-14

## Status

Accepted

Amends the reference model of
[ADR 3 (Search API core query model)](./0003-search-api-core-query-model.md) and
narrows [ADR 8 (Resolve reference labels from per-reference label sources)](./0008-resolve-reference-labels-from-per-reference-label-sources.md).

## Context

A `labelOnly` reference carried `{ id, label }` and nothing else, so any other
field of the referent cost a second query keyed off the id just received –
`creativeWorks → dataset { id }`, then `datasets(where: { id: { in: … } })`,
purely to reach `license`.

The round-trip that would carry those fields is already made: after a search,
the label lookup dedupes the page’s referenced IRIs, groups them by collection
and fires one batched `multi_search` – then keeps the label and discards the
document.

## Decision

### Three shapes, one axis: where the fields come from

- `idOnly` – a bare IRI, carrying no fields. Unchanged by this decision.
- `lookup` – fields read from the target’s **own indexed document**. Replaces `labelOnly`.
- `inline` – fields denormalised from the **parent’s** RDF framing at index time.

Inline framing must be reachable from the parent root: a Dataset’s licence comes
from the Dataset Register, never the CreativeWork’s graph, so no framing depth
reaches it.

### A lookup names its target once

`lookup` takes `target`: the Root Type whose collection the fields are read
from, and whose name the emitted type derives from. It replaces both
`labelSource` (which named the collection) and `ref.typeName` (which named the
emitted type) – for every real `labelOnly`, one type declared twice.

`labelSource` survives only on `idOnly`, which names no target and still needs
its facet buckets labelled.

### The query says what to resolve, not the declaration

A lookup declares no field list. Two references on one target with different
lists would both want to be `‹Target›Reference` with different shapes, and every
fix is worse: derive the name from the field set, or forbid the disagreement so
one declaration constrains another. One target, one emitted type – carrying the
target’s `output` fields, as `inline` already does.

What is _fetched_ is named per query instead, by a projection on `SearchQuery`:

```ts
interface SearchQuery {
  // query, where, orderBy, facets, limit, offset …
  readonly resolve?: ReferenceProjection;
}

type ReferenceProjection = Readonly<
  Record<
    string,
    {
      readonly fields?: readonly string[];
      readonly resolve?: ReferenceProjection; // the next level down
    }
  >
>;
```

The GraphQL surface builds it from the client’s selection set, so a lookup
fetches what was asked for. Omitted, it means label-only, and every pre-existing
caller keeps its behaviour.

Nesting is what makes depth possible at all: `dataset { publisher { label } }`
is one batched lookup for the page’s datasets, then one for the publishers they
name: **one round trip per level**, not per document, since the adapter still
dedupes by IRI and groups by collection. Without a projection nothing bounds the
depth, and a depth declared per reference is the field list wearing a hat. The
surface caps it, where the cost and max-depth limiters already sit.

The port stays proportionate: today a caller learns two methods, six
`SearchQuery` keys, four result shapes (`SearchResult`, `Reference`,
`NestedDocument`, `FacetBucket`) and one guard. This adds a seventh key; no new
method, and no new result shape, since a lookup returns the `NestedDocument`
`inline` already returns, while `Reference` (`{ id, label? }`) still serves
`idOnly` and facet buckets. An invalid projection fails through
`assertValidQuery`.

Rejected: leaving `SearchQuery` untouched and adding a second port method –
`resolveReferences(target, iris, fields)` – which the surface calls once per
level, feeding it the IRIs the level above returned. That moves the loop out of
the adapter, and with it the dedupe, grouping, single-flighting and caching that
live there: the next surface reimplements all of it, and an adapter that sees
one level at a time can never fold two into one `multi_search`.

### Facet buckets stay label-only

A bucket is a value, a count and one label; never a field set. So the bucket
path still selects the single field the type designates as its label
([ADR 8](./0008-resolve-reference-labels-from-per-reference-label-sources.md),
as amended by `labelField`): for a `lookup` off its `target`, for an `idOnly`
off its `labelSource`.

That keeps the opt-in label cache (`labelCacheTtlMs`) intact. It holds a whole
collection’s labels, affordable only because a label is one small value per
document; caching whole documents would bound memory by the collection, which
[ADR 12](./0012-bound-memory-by-the-unit-of-work-not-the-input.md) rules out.
Facets stay cacheable; a projected hit lookup is not.

## Consequences

- A consumer reads a referent’s indexed fields, at any depth it selects, in
  round-trips already in flight. The second query disappears.
- Breaking: `strategy: 'labelOnly'` → `strategy: 'lookup'`, and
  `labelSource`/`ref.typeName` → `target`. Emitted GraphQL is unchanged for a
  client selecting only a label.
- The surface threads its selection set into the query; the port gains a
  projection, and the conformance suite a case for it.
- A recursive projection invites per-level options, and each one multiplies with
  depth. It stays narrow by being the selection set’s own shape, not a second
  vocabulary.
- Nothing changes at index time.
- Complements the Typesense join
  ([#712](https://github.com/ldelements/lde/issues/712)) rather than competing:
  the join is the filter story and copies the referent into every hit, where a
  lookup dedupes by IRI first.
