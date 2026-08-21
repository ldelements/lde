# 22. Key a root type on a declared field

Date: 2026-08-21

## Status

Accepted

Extends [ADR 20](./0020-resolve-a-references-fields-from-the-targets-own-collection.md),
whose contract – a reference holds ids of documents in the target’s collection –
is what makes reference rewriting a consequence rather than a new rule. Relates
to [ADR 11](./0011-decouple-rdf-depth-from-the-api-surface.md) (inline
references, the other way a referent reaches a document) and
[ADR 12](./0012-bound-memory-by-the-unit-of-work-not-the-input.md).

## Context

A search document is keyed on the IRI of the node it was projected from. That is
the right default and wrong for a whole class of profiles: where a publisher
models an entity as its own node and states, in the graph, that the node _is_
some agreed term – SCHEMA-AP-NDE § 3.4 says exactly this for every
`DefinedTerm` – two publishers describing one place produce two documents, two
facet buckets and two entity pages, and neither can be reached from the other.

The fact that decides the key is in the graph, one hop from every node that
needs it, and already readable as an ordinary declared field. What was missing
was a way for the schema to say **which field holds the key**.

The alternative on the table was to move root selection into the deployment – a
`DISTINCT`/`BIND` selector minting roots that carry no triples, and a reader
transform told the batch’s bindings so it could mint content for them. That
works, but it puts a generic seam in `@lde/pipeline`, makes every keyed root an
empty CONSTRUCT, and writes the deployment’s rule twice: once as a SPARQL
`FILTER` in the selector and once in JavaScript in each transform that has to
rewrite a reference, with a standing obligation that the two never disagree.

## Decision

A Root Type is keyed on the node’s IRI unless it names a **`key` field** to read
the key from. A reference to such a type stores the target’s key.

```ts
key: {
  field: '_sameAs',
  pick: (candidates) => candidates.find(isGeoNames) ?? candidates.find(isCovered),
}
```

`key.field` names a declared field of the type: a `path`-bearing, `array`
reference field that is not `inline`. Naming a **declared field** rather than a
path or a pseudo-field is the whole point – the extraction branch already exists,
a reader transform that repairs reference values covers the candidates the day
the field is declared, and the field’s own `transform` is where IRI
normalisation lives, so two spellings of one IRI become one candidate before
anything chooses between them.

`key.pick` is the deployment’s choice among the candidates, defaulting to the
first. LDE never inspects an IRI’s shape – it asks.

### The guards

Candidates reach `pick` transformed, IRI-filtered, deduplicated and **sorted**,
so the default is deterministic whatever order the CONSTRUCT returned them in;
`pick` must return one of them or `undefined`, so a key is always either an IRI
the graph offered for that node or the node’s own, never one invented in
between. `pick` must be pure: the same function keys the document and every
reference to it, so an impure one could key those two differently and leave a
reference dangling.

`documentKeyOf` is that whole rule in one exported function, so a transform that
needs a node’s key before the projection runs reads the same answer the
projection will.

### The boundary, for keys and for joins alike

Only a reference that **names** its target – a `lookup`’s `target`, an
`idOnly`’s `labelSource` – is re-keyed. That is the same line a join draws, and
for the same reason: naming the target is what asserts that the field holds ids
of that collection’s documents. An `idOnly` reference with no label source, and
a `derive`d reference over a raw internal path, never claimed as much, so
nothing rewrites them.

## Consequences

- **Several nodes with one key are one document.** That is what a document key
  means; the writer upserts by `id`. A deployment that wants the merged document
  to carry particular content attaches a transform; one that does not gets
  last-writer-wins, exactly as a shared entity across datasets behaves today.
  The projection still emits one document per distinct root – folding them is
  the writer’s upsert, not the projection’s.
- **Shared documents become the norm rather than the edge case**, which
  multiplies the exposure of the single-valued provenance stamp: when one
  contributor leaves the run while another that still references the entity is
  skipped, the membership sweep can delete a document that is still referenced.
  The design does not make this worse per document, but it makes it common.
- **The CONSTRUCT grows** one `OPTIONAL` hop per reference into a keyed type, and
  the frame carries the referent’s key-field values. `OPTIONAL` rather than
  conjoined, so an unaligned referent keeps its row – and its own IRI – instead
  of dropping out of the extraction.
- **A transform that replaces a root’s quads must re-emit the key field.** The
  existing rule – a field the document needs must be in the stream – applied to
  one more field; a transform that only adds never meets it. Left as a
  convention rather than a guarantee: the structural alternative (reading the key
  off the reader’s raw output before transforms run) touches `@lde/pipeline`’s
  runner, the one package this design otherwise leaves alone.
- **A transform that supplies key candidates must reach every referring type.**
  A transform is attached to one type’s reader, and a reference’s key is read in
  the _referring_ type’s extraction query – so candidates minted on the target
  alone key the target’s own document while every reference to it still stores
  the node IRI. Repairing candidates the graph already carries is unaffected
  (a reader transform on the referring type covers its own hop); supplying them
  is what has to reach both, or be supplied upstream.
- **The key is assigned before any `derive` runs**, so a derive sees the key and
  never the node IRI. A deployment that wants the node IRI declares a plain
  `idOnly` reference over the same path.
- **A cross-dataset node reference does not resolve.** A work in dataset A
  pointing at a local node in dataset B gets no candidates – the hop runs against
  A’s distribution – so it stores the node IRI and dangles against B’s keyed
  document. Publishers reference other publishers through `sameAs` rather than
  directly, and such a reference is already unresolvable today for every purpose
  but labels.
- `@lde/pipeline`, `@lde/search-indexer` and the API packages are untouched, and
  `@lde/search-typesense` only adopts the shared `rootTypeNamed` in place of a
  by-name map of its own: the change is a schema member, the projection, and one
  hop in the extraction generator. A schema declaring no `key` extracts,
  projects, indexes and queries exactly as before.

## Rejected

**A deployment-supplied selector plus `bindings` on reader transforms.** Correct,
but it solves _ids come from the selector_ by moving the selector to the
deployment rather than by letting the schema say what a key is. It reaches the
goal at the cost of a generic seam in `@lde/pipeline`, an empty CONSTRUCT per
keyed root, and a rule every consumer must restate in two languages.

**Framing the member in Linked Data sameness vocabulary** (`identity: {
alignment, canonical }`). Same mechanics, but it made LDE state rules – “several
nodes merge”, “references are rewritten” – that in search-document terms are
just what keys already do. _Identity_, _alignment_, _canonical_ and _authority_
are the deployment’s words, and stay in the deployment’s schema.

**`key: { path }` with a pseudo-field.** A pseudo-field is invisible to
everything that works on declared fields: a reader transform that enumerates
reference-field aliases would not see it, so a publisher writing the alignment as
a typed literal would silently yield no candidates; IRI normalisation would have
nowhere to live, so two spellings of one IRI would silently fail to merge; the
extraction would need an extra root branch; and the alias would become exported
surface. Naming a declared field removes all of it.

**A derivable `id`.** A `derive` over the document key re-keys the document but
cannot reach a reference on another type: the hop to the referent’s key field has
to be _extracted_, and only a declaration the extraction generator can see makes
that happen.

**Putting `key` in the indexer’s extensions** rather than in the schema. It keeps
the predicate in app code next to the deployment’s other logic, but the
extraction generator and the projection both need it, so it would have to be
threaded through the stage factory and the pipeline – the ripple the schema
placement avoids. A transform reads the declaration off the loaded schema, so
nothing is lost.
