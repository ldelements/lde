# 39. Apply a label source’s transforms to its referents

Date: 2026-11-16

## Status

Accepted

Amends [ADR 38](0038-search-a-document-by-its-referents-labels.md).

## Context

ADR 38 searches a reference by the labels the referring graph states for its
referents. A label a transform gives the target’s documents never reaches the
referrer. In Linked Open Limburg, the `Term` type’s transform replaces a keyed
term’s content with its Authority’s, so the Term document for a Cultuurhistorische
Thesaurus concept is called “boerenbont”, while a work referencing it is
searched only by what its own publisher calls the term – nothing, where the
publisher’s label is untagged and so outside the label field’s locales
([limburg/lol#318](https://codeberg.org/limburg/lol/issues/318),
[lde#1058](https://github.com/ldelements/lde/issues/1058)).

## Decision

Before projection, a stage passes the referents of its `searchable`
references, its inline referents’ included, through each target type’s own
transforms.

- **Only the referent’s key and label quads go in**, under the target’s IR
  Aliases, and what the transforms return replaces them. The referent’s
  `rdf:type`, and every quad the referrer reads for its own fields, stay out.
- **It runs inside the batch**, after the stage’s own transforms, so memory
  stays bounded by `batchSize` ([ADR 12](0012-bound-memory-by-the-unit-of-work-not-the-input.md)).
- **A reference to its own type is skipped**: the type’s transform already
  sees the batch. A target wired with its own `readers` has no transform to
  apply.

## Consequences

- The referrer is searched by the labels the target’s transform leaves. Where it
  replaces a publisher’s label with an Authority’s, the publisher’s is no longer
  searched, as it is no longer on the target’s document.
- No stage order is needed, and a referent is covered whichever dataset its
  target document comes from, as long as the referring graph states its key or
  label. One described only in another dataset’s graph still adds nothing.
- A transform on a label source must cope with nodes carrying only a key and a
  label, and runs once per referring batch as well as for its own roots. A
  transform doing I/O pays for it there too, unless it caches.
- A referent stated by IRI alone has no quad for a transform to act on, so it
  adds nothing to search.
- Labels are copies, changed only when the referrer is reindexed.

## Alternatives considered

- **Copy labels from the target’s projected documents, held in memory for the
  dataset pass.** No transform runs twice, but the index grows with the dataset,
  which ADR 12 rules out; it also needs label sources’ stages to run first and
  misses referents from other datasets.
- **The same index on disk.** Bounded memory, but a store to manage per run for
  a copy the transform can recompute.
- **Patch referrers in the writer before commit**, paging through the
  collections. Bounded and complete, but it rewrites whole collections through
  the engine on every run, outside the engine-neutral projection.
