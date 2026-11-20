# 42. Count a referent’s leaf, and a field’s facets in one object

Date: 2026-11-16

## Status

Accepted

Extends [ADR 39](0039-apply-a-label-sources-transforms-to-its-referents.md)
and [ADR 41](0041-filter-and-facet-a-root-document-on-whether-an-entrys-leaf-has-a-value.md);
lifts the refusals ADR 36, ADR 40 and ADR 41 made for the facet shape.

## Context

Linked Open Limburg’s map view filters works on whether a place they name has
coordinates. `contentLocation` is a lookup into `Place`, whose coordinates
come from GeoNames enrichment, not from the work’s graph. The root document
stores only the places’ ids, so LOL guesses from each place’s key: a GeoNames
IRI counts as located. When a GeoNames lookup fails, the place is indexed
without coordinates and the work still says it has them.

ADR 41 counts a leaf of an inline reference’s entries, which the root
document stores. A lookup’s referents are other documents, possibly from
other datasets, so reading the leaf off the target’s collection would need a
pass after every dataset, or an order across them.

Separately, the facets object had one key per facetable field, typed as a
bucket list. ADR 36, ADR 40 and ADR 41 therefore refused anything that would
give one key two meanings: presence on a facetable field, leaves on a
facetable reference, a leaf faceted both by value and by presence.

## Decision

- **A lookup declares `presenceLeaves`** naming leaves of its target, as an
  inline reference does since ADR 41:
  `ref: { strategy: 'lookup', target: 'Place', presenceLeaves: ['latitude'] }`.
  One boolean per root document, `contentLocation_latitude_exists`, in
  `PhysicalFields.leafExists`. Only on a lookup naming one target: a leaf is
  read through one declaration.
- **Counted at index time, in the referring batch.** The extraction reads each
  presence leaf one hop from the root, beside the target’s key and label. The
  stage passes the referents through the target type’s transforms, as ADR 39
  does for labels, and the projection reads the leaf off each referent’s node
  as the target declares it. No pass after all datasets: what the root’s graph
  states, or a transform can say from the referent’s key, is counted;
  anything else is not, and the work counts as holding none – so a failed
  lookup gives `false`, not the guess’s `true`. Only a referent named by IRI
  counts: a blank node is no id the lookup stores.
- **A referent named by IRI alone is seeded.** ADR 39 hands a transform only
  the quads the batch has, so such a referent reached no transform. A referent
  a presence leaf is counted for enters its target’s transforms as
  `<referent> rdf:type <class>`, and the seed is dropped from what comes
  back. A transform describing a node from its key, as LOL’s place transform
  does, then supplies the leaf. A lookup into its own type seeds through that
  type’s transforms too, though they saw the batch: they never saw a referent
  the batch states nothing of.
- **The target declares the leaf, with a `path`.** A leaf is read off the
  referent’s node through the target’s declaration, not derived.
- **A plain criterion on the root selects it**, naming the reference and the
  leaf: `{ field: 'contentLocation', leaf: 'latitude', exists: true }`. The
  value is the root document’s, so it combines with other criteria like any,
  and each key of a lookup’s GraphQL `where` is one such criterion, ANDed like
  sibling keys – two presence leaves in one `where` are two conditions. A
  lookup takes no weld: it has no entries.
- **One facet object per field.** A field counting more than its own values
  is served as `‹Type›‹Field›Facet`: its own values in `buckets` and
  `totalValues` (a numeric field’s range facet parts instead), capped by the
  field’s `limit`; `exists` for its presence; one key per leaf, a plain facet
  type for a leaf counted by value only and `‹Type›‹Field›‹Leaf›Facet` for
  one whose presence is counted. A field counting only its own values keeps
  `IRIFacet`, `ValueFacet` or its range facet type. A leaf is not named
  `buckets`, `totalValues` or `exists`.
- **One filter input per reference counting leaves.** `‹Type›‹Field›Filter`
  holds the reference’s `in` and a `where`, `‹Type›‹Field›Where`, naming its
  filterable entry leaves and its presence leaves. Two references nesting one
  Reference Type may then declare different leaves, which ADR 41 refused.
  Adding leaves to a reference therefore changes its filter type, from the
  shared `‹Edge›Filter` or `‹Target›Filter` to its own – a breaking change
  for a client whose variables name the old type.

## Consequences

- LOL declares `presenceLeaves: ['latitude']` on `contentLocation` and
  `locationCreated`, and drops its key-based guess.
- Lifted: presence on a facetable field (ADR 40), leaves on a facetable
  reference (ADR 36, ADR 41), a leaf faceted by value and by presence (ADR
  41), and one set of presence leaves per Reference Type (ADR 41).
- Breaking at the GraphQL surface: ADR 36’s `‹Type›‹Reference›Facets` and ADR
  40 and 41’s `…Facets` objects are renamed `…Facet`; a field that gains a
  leaf or `exists` changes from `IRIFacet`/`ValueFacet` to its own object; a
  reference counting leaves takes `‹Type›‹Field›Filter` instead of
  `‹Edge›Filter` or `‹Target›Filter`, so the refined discovery strategy no
  longer reaches it – and a reference that gains its first leaf later breaks
  the variables typed with its old filter.
- Each part of a field’s facet object is charged as a facet key, so selecting
  `buckets` with `totalValues` costs two where a plain facet costs one – an
  overestimate, never a part that costs nothing.
- A target’s transform now also receives nodes carrying a type alone, once per
  referring batch, and pays for any I/O it does there unless it caches.
- A value is a copy, changed only when the referring document is reindexed.
- Refused for now: presence leaves on a lookup naming several targets, on a
  `joinable` lookup, whose `where` already joins, and on a lookup reading its
  literals as periods. A lookup’s leaves faceted by value have no consumer
  and are not offered.

## Alternatives considered

- **A pass after all datasets, from the collection being built**, as the
  issue first proposed. Complete for referents described only in another
  dataset’s graph, but a pass over every referring document per run, skipped
  datasets included, outside the batch.
- **A Typesense join facet** (`facet_by=$places(latitude)`). On 30.2 it counted
  the joined documents, not the roots, and returned nothing on a text query
  without a filter.
- **A weld of one `exists` condition**, as for an inline entry:
  `{ field: 'contentLocation', entry: [{ field: 'latitude', exists }] }`.
  It pretends a lookup has entries, needs a special case wherever a weld is
  read, and cannot hold two leaves, which a weld puts on one entry.
- **Counting through any of several targets.** A referent of either kind
  would be read through its own target’s declaration, at the cost of a leaf
  every target must declare alike; no consumer names several targets yet.
- **The reference’s own buckets under `id`**, beside its leaves. Every
  facetable reference would change shape, where a field counting only its own
  values needs none.
