# Search

The engine- and domain-agnostic search model: one declarative schema drives
extraction, projection, the engine collection definition, the query semantics
and the GraphQL surface, so they cannot drift. LDE ships the capabilities; a
**Deployment** supplies every domain semantic.

Every term here is one `@lde/search` itself has an opinion about. Terms owned by
another context – `Reader`, `Writer` and root selection (`@lde/pipeline`), grain
and substrate (a Deployment’s choice of what to index, see
[#534](https://github.com/ldelements/lde/issues/534)) – are used, never
redefined: a second definition is a second thing to drift.

## Language

### The declaration

**Deployment**:
The consumer that supplies every domain semantic – which types exist, which
fields are references, what each resolves against, what is worth indexing. LDE
ships capabilities and names no domain; a Deployment names them all. The Dataset
Register is one.
_Avoid_: consumer, client, application, tenant

**Search Schema**:
The complete search declaration of a Deployment: every Root Type, keyed by its
class IRI. Nominal – `searchSchema()` is the only constructor.
_Avoid_: shapes graph, index config

**Search Type**:
One type’s declaration: a logical API name, the RDF class its instances carry,
and its fields. Either a **Root Type** or a **Reference Type**.
_Avoid_: shape, entity, model

**Root Type**:
A Search Type that is indexed: it declares a `class`, roots are selected for it,
and a Writer owns a collection for it. The Search Schema is keyed by it.
_Avoid_: top-level type, indexed type

**Reference Type**:
A Search Type reached only through a reference. Declares **no `class`** – never
selected, never framed by type, never indexed; its identity is its name. The
shape an **Inline Reference** carries.
_Avoid_: nested type, sub-type, embedded type

**Search Field**:
One projected value: read from the graph via a **Path** or computed via a
**Derive**, exposing exactly the **Roles** it declares – possibly none.
_Avoid_: property, attribute, column

**Role**:
A capability a Search Field opts into: `output`, `searchable`, `filterable`,
`facetable`, `sortable`. Independent; a field exposes exactly what it declares.
_Avoid_: flag, capability

**Internal Field**:
A Search Field declaring no Role. Projected into the Document so later Derives
can read it, then pruned before the writer sees it. Never stored, never indexed,
absent from the collection definition.
_Avoid_: hidden field, scratch field, private field

**Path**:
A Search Field’s **source address** – what to read from the graph, **relative to
the node of the type that declares it** (a Root Type’s root, a Reference Type’s
referent). Opaque to `@lde/search`; the read-side adapter owns its grammar (for
a SPARQL reader, a property path).
_Avoid_: sh:path, predicate, selector

**Derive**:
A Search Field’s computation – what to compute from what was already read. Runs
in declaration order over the Document; never touches the graph.
_Avoid_: transform, resolver, mapper

A field has a Path or a Derive, never both. **Path says what to read; Derive
says what to compute from what was read.**

Two absences declare intent, and both are load-bearing: **a field without a Role
is an Internal Field; a type without a `class` is a Reference Type.**

### References

**Label Source**:
The Search Type whose collection resolves a reference’s labels. Must declare an
`output`, `searchable` text field named `label`.
_Avoid_: labels collection, lookup table

**Reference Strategy**:
How much of a referenced entity a reference carries: `idOnly` (the IRI),
`labelOnly` (+ its Label Source’s label, resolved at query time), `inline`
(+ its Reference Type’s projected fields).

**Inline Reference**:
A reference carrying its referent’s projected fields. Serves two jobs, told
apart only by Roles:

- _reading device_ (no Roles → an **Internal Field**): reach a value behind a
  _qualified_ hop by inlining the intermediate node with its discriminator, then
  let a **Derive** select and flatten it. Pruned before the writer – nothing
  nested reaches the engine or the API.
- _API device_ (`output`): deliberately surface a nested Reference Type.

RDF depth and API shape are therefore independent: inline as deep as the source
demands, expose exactly the flat fields you want
([ADR 11](../../docs/decisions/0011-decouple-rdf-depth-from-the-api-surface.md)).

### Reading and writing

**Extraction**:
Producing a Deployment’s quads for one root. Emits **IR Aliases**, not the
source vocabulary.
_Avoid_: fetch, crawl, source query

**IR Alias**:
The minted `urn:lde:‹Type›/‹field›` predicate an extraction CONSTRUCT emits for
a Search Field’s value, and the key the projection reads it back under.
Mechanical, per field; never hand-written, never a public vocabulary.
_Avoid_: dr: predicate, intermediate vocabulary, internal namespace

**Projection**:
Turning one root’s framed quads into a **Document**. The one type-changing step
(quad → document); shared across all engines.
_Avoid_: mapping, serialization

**Document**:
The engine-agnostic logical record the projection emits and a writer consumes.
The shared contract between the engine-agnostic side and every engine adapter.
_Avoid_: record, row, hit

**Physical Field**:
A field the engine actually stores – `title_search_nl`, `title_sort_nl`,
`title_nl`. One Search Field fans out into several; `physicalFields()` owns the
convention, so the projection, the collection definition and the query compiler
cannot disagree.
_Avoid_: column, engine field

## Flagged ambiguities

**Field**: unqualified, ambiguous between a **Search Field** (the declaration)
and a **Physical Field** (what the engine stores). One declaration becomes
several stored fields, so the two are never one-to-one. Qualify which you mean.

## Example dialogue

> **Dev:** The Dataset type has `publisherName` _and_ `publisher`. Isn’t one of
> them redundant?
>
> **Expert:** No – different jobs. `publisher` is a reference: it holds the
> organization’s IRI, so we can facet on it, and the label gets resolved at
> query time from the Organization collection. That’s its Label Source.
> `publisherName` is text flattened onto the dataset itself, so the
> organization’s name lands in the dataset’s own free-text search.
>
> **Dev:** So `publisherName`’s Path is `dct:publisher/foaf:name`. But then what
> predicate does the extraction emit?
>
> **Expert:** An IR Alias – `urn:lde:Dataset/publisherName`. It has to mint one:
> you can’t put a property path in a CONSTRUCT template. The projection reads
> the value back under that alias.
>
> **Dev:** And nobody writes that alias by hand?
>
> **Expert:** Nobody. It’s a function of the field name. The day someone
> hand-writes one, it can drift from the schema – that’s exactly what we’re
> getting rid of.
>
> **Dev:** The compatibility booleans read `quadsValidated`. Is that a field?
>
> **Expert:** An Internal Field. It declares no Role, so it’s projected into the
> Document for the Derives to read and pruned before the writer. It never
> reaches the engine – not stored, not indexed, not in the collection
> definition.
>
> **Dev:** Why not just read it off the graph inside the Derive?
>
> **Expert:** Because then the extraction generator can’t see it. Path says what
> to read; Derive says what to compute from what was read. If a Derive reaches
> into the graph, the schema stops being the whole story and the CONSTRUCT can
> drift again.
