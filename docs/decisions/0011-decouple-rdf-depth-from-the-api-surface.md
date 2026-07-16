# 11. Decouple RDF depth from the API surface

Date: 2026-07-16

## Status

Proposed

Extends the reference model of
[ADR 8 (Resolve reference labels from per-reference label sources)](./0008-resolve-reference-labels-from-per-reference-label-sources.md)
by realising the `inline` strategy it forward-declared. Depends on the
`path`/`derive` split ([#607](https://github.com/ldelements/lde/issues/607));
implemented by [#608](https://github.com/ldelements/lde/issues/608) and consumed
by the extraction generator ([#548](https://github.com/ldelements/lde/issues/548)).

## Context

A `SearchField.path` addresses a value from the node of the type that declares
it. Some values cannot be addressed at all.

The obstacle is the **qualified hop** – one whose intermediate node must be
filtered to identify the value. The sharpest case in the Dataset Register:
`quadsValidated`, `schemaApNdeConformant`, `subjectUrisSampled`,
`subjectUrisResolved` and `subjectNamespaceDurable` are **five fields sharing one
path** (`dqv:hasQualityMeasurement/dqv:value`), differing _only_ by the
intermediate node’s `dqv:isMeasurementOf`. No path expression tells them apart:
SPARQL property paths cannot constrain an intermediate node, and SHACL does not
either – it needs `sh:qualifiedValueShape`, a **constraint**, not a path. The
IIIF measurements need two such hops; the terminology-source linkset needs one
plus an inverse.

The Dataset Register works around this with a private `dr:` vocabulary: a
hand-written CONSTRUCT flattens each awkward value onto the dataset under a
minted predicate, and the schema declares `path: 'urn:dr:quadsValidated'`. That
is the debt #548 retires, and it cannot be retired without answering: **how does
a declaration address a value behind a qualified hop?**

Two answers:

- **(a) Grow the path grammar** – admit `[predicate = value]` filters on
  intermediate nodes.
- **(b) Inline the intermediate node** with its discriminator, and let a
  `derive` select from it.

(a) is a query language wearing an address’s clothes. `@lde/search` would own a
path expression language and its SPARQL compiler; every declaration would carry
the shape of the source graph; and the “generator” would be a compiler. It also
does not reach the aggregate cases at any expressiveness – newest-registration-
wins is a selection over a set, not a path.

(b) needs no new mechanism. The `path`/`derive` split (#607) already says _path
says what to read; derive says what to compute from what was read_ – and a
qualified hop’s filter is a computation over what was read, not part of the
address.

The apparent cost of (b) is that inlining puts a nested structure in the
document, while the deployment wants `Dataset.quadsValidated: Int` in GraphQL,
not `Dataset.measurements { isMeasurementOf value }`. Were that true, (b) would
trade a path language for an unreadable API, and (a) would look attractive again
purely to keep the surface flat. It is not true, because **roles decide what
surfaces**, and that is what makes (b) viable.

## Decision

**Reach a qualified or deep value by inlining an internal reference and deriving
from it – never by extending the path grammar.**

- **An inline reference declaring no role is a reading device.** It is an
  internal field (#607): projected into the in-memory document so later derives
  can read it, then pruned before the writer. It reaches neither the engine
  (not stored, not indexed, absent from the collection definition) nor the API.
  The five DQV fields inline `dqv:hasQualityMeasurement` once and derive from
  it – which is exactly what the Dataset Register’s `qualityMeasurements`
  `WeakMap` memo hand-rolls today, made structural.

- **The same mechanism declaring `output` is an API device.** It deliberately
  surfaces a nested reference type. Same construct; the roles, not the strategy,
  decide.

- **`path` stays a plain address** – a SPARQL property path for a SPARQL reader,
  opaque to `@lde/search`, which never learns a filter language.

- **Therefore RDF depth and API shape are independent.** Inline as deep as the
  source demands; expose exactly the flat fields you want. Three tools, and the
  surface is chosen per field:

  | RDF shape                                                        | Tool                       | Surface |
  | ---------------------------------------------------------------- | -------------------------- | ------- |
  | simple deep value (`dct:publisher/foaf:name`)                    | property path              | flat    |
  | qualified/selected deep value (`…[isMeasurementOf X]/dqv:value`) | internal inline + `derive` | flat    |
  | nesting is wanted (`creator { name }`)                           | inline + `output`          | nested  |

## Consequences

- **The GraphQL surface is free of the source’s shape.** A future reader who
  finds a reference field declaring no roles, resolving to a type with no
  `class`, and apparently going nowhere, should read this ADR before deleting it
  or marking it `output`: either silently re-couples RDF depth to the public
  contract.

- **Filtering has one home.** A `where` clause on a reference declaration would
  be a qualified path wearing a hat, and re-opens option (a) by increments. If a
  deployment wants less boilerplate than five near-identical
  `find(m => m.isMeasurementOf === X)?.value` derives, it factors a helper of
  its own – the declaration stays an address.

- **Framing keeps `jsonld` and gains depth.** A flat-only schema could replace
  framing with a group-by-subject; inline genuinely needs the one-hop embed, and
  the Dataset Register needs two levels. Depth follows the reference graph, so it
  is a property of the declaration – `searchSchema` rejects inline cycles, the
  only way it could be unbounded. Bounded per batch
  ([#606](https://github.com/ldelements/lde/issues/606)), so the O(N²)
  whole-graph framing cost `frame-by-type` warns about applies to `batchSize`
  roots, not to the graph.

- **Extraction must reassemble the nesting.** An inline reference’s referent is a
  second subject, so extraction emits both the edge and the referent’s values,
  and the framer joins them by node identity. How many queries that takes is the
  generator’s concern ([#548](https://github.com/ldelements/lde/issues/548)), not
  this ADR’s: the decision here is where filtering lives, and it holds whatever
  shape the queries end up in.

- **`sh:qualifiedValueShape` stays available as an upstream source.** Since a
  qualified hop is expressed in SHACL as a constraint rather than a path, a
  future SHACL → `SearchSchema` generator (#325) maps it to an inline reference
  plus a derive – the same target this ADR chooses by hand.
