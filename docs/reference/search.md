# @lde/search

The core of the LDE search family: packages that together act as a **generator
for search engines**. You write one declarative `SearchSchema`, and everything
a running search engine needs is derived from it: the document projection, the
engine collection definition, the query semantics, and the API surface. All these
are kept in sync automatically rather than handwritten per deployment.

The core itself is **engine-, API- and domain-agnostic**: it bakes in no search
engine, no API protocol, and no domain vocabulary. The engine- and API-specific
halves are adapters that plug into the ports defined here:

- **engine adapters** implement the `SearchEngine` port:
  [`@lde/search-typesense`](./search-typesense), with OpenSearch to follow;
- **API surfaces** drive it, parsing client input into `search(SearchQuery)`:
  [`@lde/search-api-graphql`](./search-api-graphql), with a REST
  surface to follow.

The library never names your domain: the same core drives a `Dataset`,
`Person`, or `CreativeWork` search.

It provides four things:

- **unified field model** – `SearchField` / `SearchType` / `SearchSchema`:
  one declaration per field that drives all four consumers below, so they
  cannot drift;
- **neutral query IR** – `SearchQuery` / `Filter` / `Sort` + filter
  semantics: every API surface compiles into it, every engine adapter compiles
  out of it, so the two cannot drift;
- **engine port** – `SearchEngine` and the logical result types
  (`SearchResult` / `SearchHit` / `ResultDocument` / `Reference` /
  `NestedDocument` / …);
- **streaming projection** – `projectRoots`, RDF `CONSTRUCT` quads → flat
  search documents, one root type at a time.

```
SearchSchema ─┬─► projection      (projectRoots → flat documents)        [here]
              ├─► engine adapter  (collection definition + query compiler)   e.g. @lde/search-typesense
              ├─► query semantics (SearchQuery, filter/sort/facet)       [here]
              └─► API surface     (GraphQL / REST)                       e.g. @lde/search-api-graphql
```

At runtime, everything those consumers do is a **pure transformation between
data shapes**, each one parameterised by the schema – three chains, meeting at
the engine:

```
indexing:  RDF quads ──frame──► FramedNode ──project──► SearchDocument ──import──► engine
querying:  client input ──parse──► SearchQuery ──compile──► engine query
results:   engine response ──parse──► SearchResult ──shape──► API output
```

Validation happens before the first arrow (SHACL over the RDF) and inside the
last (the engine enforces its collection definition); between them every stage is
a typed, deterministic function – easy to test, and swappable per deployment.

## Installation

```sh
npm install @lde/search
```

## Entry points

Exports are stratified by audience:

- **`@lde/search`** – the authoring surface: `defineSearchType`,
  `searchSchema`, `projectRoots`, validation, every model/query/result type,
  and `isoToUnixSeconds` / `unixSecondsToIso` (the `date` storage codec, for a
  value the projection does not convert itself).
- **`@lde/search/adapter`** – plumbing for engine adapters and API surfaces:
  - `assertTypeInSchema` – the port membership guard (the exact declaration
    object must be in the schema);
  - `physicalFields` / `PhysicalFields` – the indexed physical fanout a field
    produces (per-locale search/sort keys, and the field a facet reads – the
    field itself, or the companion of a reference inheriting a
    [facet policy](#facet-policy), which is why it takes the schema);
  - `physicalNameTokens` – the neutral name tokens an engine formats its own
    collection/index names from;
  - `irAlias` – the minted extraction predicate
    (`urn:lde:‹Type›/‹field›`) the extraction CONSTRUCT and the projection
    share;
  - `displayFieldName` / `displayFieldPattern` / `displayLangOf` – the
    display-field naming trio for localized text;
  - `searchableFields`, `facetableFields`, `filterableFields`,
    `sortableFields`, `outputFields`, `referenceFields`, `fieldNamed` – the
    field selectors;
  - `isInternalField`, `isInlineReference`, `isRangeFacet` – the field
    predicates;
  - `referenceTypeNamed` – resolve an inline `ref.typeName` to its declared
    Reference Type;
  - `nestedReferenceType` – the Reference Type a **surfaced** (`output`) inline
    reference nests, the one predicate the collection definition, result
    reconstruction and the API surfaces share;
  - `nestedFieldName` – the nested Physical Field naming convention
    (`media.contentUrl`), the nested counterpart of `physicalFields`;
  - `inlineFramingDepth` – the framing depth a Root Type’s inline reference
    graph needs;
  - `labelFieldOf`, `labelFieldNameOf` – the text field a label source serves
    labels from, and the name it serves it under (`label` by default);
  - `filterOperatorFor`, `filterOperator`, `FilterOperator` – the kind→operator
    table and the operator a `Filter` value carries;
  - `validateQuery` / `QueryIssue`, `assertValidQuery` – query validation
    (the port’s always-on guard);
  - `pageForOffset` – the 1-based page an offset falls on (`limit: 0` pins
    to 1);
  - `isoToUnixSeconds`, `unixSecondsToIso` – the `date` storage codec.
- **`@lde/search/module`** – `loadSchemaModule`, the Node-only loader for a
  mounted schema-declaration module (an `.mjs` default-exporting declarations
  as plain data). The one loader both the indexer image and the served-API
  image boot from, so the write and the read side cannot disagree about the
  schema. It returns a `LoadedSchemaModule` – `{ schema, moduleExports }`: the
  validated `SearchSchema` plus the raw module exports, so each consumer
  validates its own optional exports (the served API reads
  `schemaOptions`/`engineOptions`; the indexer reads none).
- **`@lde/search/testing`** – `describeSearchEngineContract`, the executable
  port contract every engine adapter runs against a live instance of itself
  (vitest; optional peer).

## Terminology

The model has three levels, with analogues in SHACL ([one possible source](#why-a-declarative-model))
and GraphQL (one of the surfaces):

| Term           | What it is                                                                                                                                                                                                                       | SHACL          | GraphQL     |
| -------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------- | ----------- |
| `SearchField`  | One queryable field: a `kind`, the IR `path` it projects from, and the capability flags it opts into                                                                                                                             | property shape | field       |
| `SearchType`   | One type’s complete declaration: its logical API `name` and fields (incl. derived). A **Root Type** declares a `class` (indexed, keys the schema); a **Reference Type** declares none (reached only through an inline reference) | NodeShape      | object type |
| `SearchSchema` | The whole search declaration: every Root Type, keyed by `class` IRI, plus the Reference Types – build one with `searchSchema(...types)`                                                                                          | shapes graph   | schema      |

A `SearchType` is a **Root Type** or a **Reference Type**, told apart by one
absence: a Root Type declares a `class`, so roots are selected for it and a
writer opens a collection for it; a Reference Type declares none, so it is
never selected, framed by type or indexed – its identity is its name, and its
type comes from the edge that points at it. `searchSchema` partitions its
arguments accordingly: Root Types key the class map (`schema.values()` yields
only them, so no writer ever opens a collection for a Reference Type), Reference
Types go into a name index an inline `ref.typeName` resolves against. The
absence is load-bearing, and enforced at the type level – an indexed Reference
Type fails to compile ([ADR 11](../decisions/0011-decouple-rdf-depth-from-the-api-surface)).

`projectRoots` and the engine port each execute one `SearchType` at a time –
projection over the roots the pipeline selector supplied for that type; the
GraphQL surface consumes the whole `SearchSchema`.

### API conventions

Two conventions hold across the whole family:

- **Parameter order** – a function takes the value it operates on first and
  the declaration right after it: `validateQuery(query, type)`,
  `buildSearchParams(query, type)`,
  `createTypesenseSearchEngine(client, schema, options)`,
  `engine.search(type, query)`.
- **Factory verbs** – the verb tells you what kind of thing comes back.
  `define*` captures a declaration as a literal (`defineSearchType`);
  `build*` is a pure data-to-data constructor (`buildCollectionDefinition`,
  `buildSearchParams`, `buildGraphQLSchema`); `create*` makes a stateful
  instance (`createTypesenseSearchEngine`). A bare noun (`searchSchema`)
  constructs the trivial container it names.

## Field model

The mapping is data, not code. Each field declares its `kind`, its value source,
and the capabilities (**roles**) it opts into. There are three mutually
exclusive value sources: the IR `path` to read; a `derive` function for a
**derived** field, computed from the document in declaration order – so it may
read fields declared before it, never the graph; or `from`, naming a
[projection value](#projection-values) the run knows and the graph does not.
`path` is therefore the complete statement of what the projection reads from the
graph. A field that
declares **no** role is an **internal field**: projected so a later `derive` can
read it, then pruned before the writer and absent from the collection definition
– not stored, not indexed, no RAM. The physical field names a declaration fans
out to (per-locale search/sort keys, the field a facet reads) come from
`physicalFields`, the single convention projection, the collection definition
and the query compiler all share.

```ts
import { defineSearchType, projectRoots, searchSchema } from '@lde/search';

const DATASET = defineSearchType({
  name: 'Dataset', // logical API name: names the GraphQL type, a REST path, …
  class: 'http://www.w3.org/ns/dcat#Dataset',
  fields: [
    // → title_<lang> (display, every present language), title_search_nl/_en, title_sort_nl/_en
    {
      name: 'title',
      path: 'http://purl.org/dc/terms/title',
      kind: 'text',
      locales: ['nl', 'en'],
      output: true,
      searchable: { weight: 5 },
      sortable: true,
    },
    // → publisher (IRI facet, resolved to a labelled reference at the surface)
    {
      name: 'publisher',
      path: 'http://purl.org/dc/terms/publisher',
      kind: 'reference',
      facetable: true,
      output: true,
      ref: { strategy: 'lookup', target: 'Organization' },
    },
    // → size (int)
    { name: 'size', path: 'urn:dr:size', kind: 'integer', sortable: true },
    // internal field (no role): projected as a reading device for the derive
    // below, then pruned before the writer – absent from the collection too
    {
      name: 'classes',
      path: 'urn:dr:class',
      kind: 'reference',
      array: true,
    },
    // derived field (no path): computed from the document in declaration order,
    // never from the graph – so `path` stays the whole statement of what is read
    {
      name: 'classCount',
      kind: 'integer',
      sortable: true,
      derive: (document) =>
        (document.classes as string[] | undefined)?.length ?? 0,
    },
  ],
});

const schema = searchSchema(DATASET);
for await (const document of projectRoots(quads, roots, schema, DATASET)) {
  // one flat search document per given root subject, streamed. The caller (the
  // pipeline selector) supplies `roots`; pairing a document with its type for a
  // multi-collection writer is the pipeline glue’s job (see
  // `@lde/search-pipeline`), not the projection’s.
}
```

`defineSearchType` captures the declaration as a literal (what
`as const satisfies SearchType` would do manually, with nothing to remember),
so typed facet/output keys can be derived from it – see
[Typed results](#typed-results) and `@lde/search-api-graphql`.

**Kinds** (`FieldKind`): `text`, `keyword`, `integer`, `number`, `boolean`,
`date`, `reference`. The Typesense/engine vocabulary and the GraphQL types are
_derived_ from the kind by the adapter and the surface – never declared here.

`SearchField` is a **discriminated union by `kind`** (`TextField`,
`KeywordField`, `ReferenceField`, `NumericField`, `BooleanField`): each kind
declares exactly the properties it can honour – `locales` on text, `ref` on
references, `facetRanges` on numerics – so an illegal declaration fails to
compile. Text is **always multilingual in shape**: `locales` lists the
language tags to **index** (search/sort), and the reserved **`und`** locale
(JSON-LD `@none`, RDF `und`) buckets untagged literals – a monolingual or
untagged corpus declares `locales: ['und']`, mixed data `['nl', 'und']`.
Display, by contrast, keeps every language present, not only the listed ones
(see [Locales](#locales)). Declaring a real language is recommended (it drives
per-locale stemming); `und` is folded but unstemmed unless `defaultLocale` opts
in, is never demoted in search weighting, and adding a language later is
additive – the API output shape never changes. Use `keyword` for exact-match
tokens, never for prose.

A `keyword` or `reference` field may declare a **`transform`** – a
projection-time value transform applied to each value as it is projected
(e.g. stripping a media-type prefix). The other kinds cannot honour one.

Two naming rules keep the physical fanout unambiguous: a **field name** must
be an identifier (`[A-Za-z_][A-Za-z0-9_]*`) – it is interpolated raw into the
physical field names and the display-field pattern – and a declared **locale**
must never contain `_`, the reserved separator between a field name and its
locale in the `${name}_search_${locale}` / display naming (declared locales
are BCP-47-shaped; incoming data tags are normalised to match at projection
time).

**Declarations are also validated at runtime** (for declarations built
outside TypeScript – a SHACL generator, plain JS): `searchSchema()`
rejects a structurally invalid declaration (duplicate or non-identifier field
names, a field named `id` – see [Lookup by IRI](#lookup-by-iri) –, a locale containing `_`, an `output`
reference without `ref`, `text` without locales, `locales` on a non-text kind,
`facetRanges` on a non-numeric kind, `searchable`/`transform` on a kind whose
projection cannot honour it, `filterable`/`facetable` on `text`, two types
sharing a `class` IRI or `name`) – the declaration-time counterpart of the
port’s always-on query validation, so a bad schema fails at startup rather
than per document at index time. `validateSearchType` /
`assertValidSearchType` are exported for validating a single declaration
directly.

| kind                 | `where`              | facet | sort             | output                                                                                |
| -------------------- | -------------------- | ----- | ---------------- | ------------------------------------------------------------------------------------- |
| `text`               | – (feeds free text)  | –     | yes (per-locale) | best-first language list                                                              |
| `keyword`            | `in` (membership)    | yes   | –                | string / `string[]`                                                                   |
| `reference`          | `in` (membership)    | yes   | –                | labelled reference (id + label), or a nested document for a surfaced inline reference |
| `integer` / `number` | `range { min, max }` | yes   | yes              | number                                                                                |
| `date`               | `range` (inclusive)  | yes   | yes              | ISO 8601 string (surface)                                                             |
| `boolean`            | `is`                 | yes   | –                | boolean (absent = false)                                                              |

A **`date`** is stored as Unix seconds – a sortable, range-filterable integer –
and is ISO 8601 at every edge: the projection converts a value on the way in,
the query compiler converts a filter bound on the way out, and the surface emits
a string. A year outside the plain four-digit form is accepted however it is written –
expanded (`-001100-01-01T00:00:00.000Z`) or not (`-1100`, `-250000`, `25000`):
the codec pads it to the signed six digits `Date` needs before parsing, so the
same value indexes and filters alike. Deep time is real data – SCHEMA-AP-NDE
blesses years beyond four digits for `schema:dateCreated` – and an unpadded year
would otherwise parse as something else entirely (a BCE year as a UTC offset,
landing in the wrong era; a five-digit CE year as a legacy local-time date,
landing a year early and differently per host timezone), without ever failing.
The window is the one `Date` can represent, ±271,821 years around 1970; a year
outside it leaves the field absent, as any unparseable value does.

**`array` decides a field’s shape**, whatever the graph carries: a declared
`array` field stores a list, and a single-valued one stores the first value –
for every kind alike, so the projection, the engine collection definition
(`string` vs `string[]`) and the API output type never describe one declaration
differently. For localized `text` the list is per language: an `array` field
keeps every value of each present language, a single-valued one the first of
each, while search folds every value either way. Declare `array: true` wherever
the source may carry several values you want to keep, including on an internal
field a `derive` counts.

A `reference` carries one of three strategies, which decide how much of the
referent it carries and therefore what it surfaces as:

| Strategy | Carries                                                  | Surfaces as     |
| -------- | -------------------------------------------------------- | --------------- |
| `idOnly` | the IRI                                                  | a bare `IRI`    |
| `lookup` | + fields read from the **target’s own indexed document** | a nested object |
| `inline` | + fields denormalised from the **parent’s** framing      | a nested object |

Reach for **`idOnly`** when the referent is not an entity this deployment
describes – a canonical vocabulary URI, a licence, a content URL. It is the only
strategy whose `ref.typeName` is optional, because it emits no type of its own to
need a name for; declare one anyway where the IRIs form a nameable set, and an
API surface can then tell them apart from IRIs at large. A `labelSource` is still
honoured for facet bucket labels: the strategy governs the output shape, not
whether a bucket can be labelled.

A **`lookup`** names its `target` once – the Root Type whose collection its
fields are read from, and the name its emitted type derives from (GraphQL:
`‹Target›Reference`, since type names must be unique). What it _fetches_ is
named per query rather than per declaration, by a
[projection](#projecting-what-a-lookup-carries); asked for nothing in
particular, it carries the target's label. Only an `inline` reference’s
`ref.typeName` resolves to a declared Reference Type.

Note what this makes true of `kind`: **a `reference` holds identity, a `keyword`
holds a literal.** A field over an IRI-valued property is a `reference` whatever
shape you want it to surface as, so no declaration has to launder one through the
other. The projection enforces the same rule from below – a reference value that
is not an absolute IRI (a blank node label, a bare token) is dropped rather than
indexed, since what a `lookup`/`idOnly` reference stores is a selection key.

An **inline reference** resolves `ref.typeName` to a declared **Reference Type**
and projects the referent through it – a nested `SearchDocument`, or an array
for an `array` reference. Its capabilities decide whether the nesting surfaces,
so the same construct serves two jobs (see
[ADR 11](../decisions/0011-decouple-rdf-depth-from-the-api-surface)):

- a **reading device** declares no role, so it is an internal field: projected
  so a later `derive` can select and flatten a value a `path` cannot address (a
  qualified hop), then pruned before the writer – nothing nested reaches the
  engine or the API;
- an **API device** declares `output`, surfacing the nested Reference Type all
  the way to the API: the engine stores the referent as a nested document, the
  engine adapter reconstructs it as one, and every surface serves the referent’s
  own fields. A multi-valued reference keeps each referent’s values grouped, so
  a consumer never pairs parallel arrays by index.

A nested field may declare `output`, `filterable` and `searchable` – free text
reaches a nested searchable field, so a name stated on an edge is matched by
`query` without a flat copy beside it. It may not
declare `facetable` or `sortable`, and `searchSchema` rejects those naming the
field: an engine's facet counts over a nested field are computed per _document_
rather than per entry, so a bucket would count entries that did not match the
filter, and there is no sorting _into_ an element of an array. Facet an edge
through its [identity companion](#data-on-the-edge) instead.

A field's **capabilities** – `output`, `filterable`, `facetable`, `sortable`,
`searchable`, `joinable`; the code calls them Roles – are independent opt-ins,
and that is what keeps nesting cheap. A nested field declaring only `output` is
stored `index: false` – kept on disk, read back with its entry, costing no
memory however large it grows – and only one that opts into a query capability
is indexed. So a schema can nest ten fields for display and index one, and pay
for the one.

A referent needs no identity of its own: the nesting carries its fields, not a
document key. A blank-node referent – whose `@id` JSON-LD 1.1 framing prunes –
nests exactly like a named one, minus the `id`, so a profile that allows a blank
node here needs no flattening workaround. A blank node label (`_:b0`) never
becomes that `id`: framing mints it per call. Only a root, which is keyed, must
be an IRI. Fields are what make a referent, so a value that projects none – a
literal under the reference’s alias, say – nests nothing.

So RDF depth and API shape stay independent: inline as deep as the source
demands, expose exactly the flat fields you want. Framing follows the inline
reference graph to the depth the schema declares (`Dataset → Subset →
Measurement` is two hops), and `searchSchema` rejects inline cycles – the one
way that depth could be unbounded – so it stays a bounded property of the
declaration.

A reference resolves labels from the Root Type whose collection holds the
referenced entities – a `lookup`'s `target`, or an `idOnly`'s `labelSource`,
which is the one place that declaration survives (an idOnly reference emits no
type, but its facet buckets are still labelled). A Root Type specifically, since
the labels are read from that collection: it must declare an `output`,
`searchable` text field named by its label field (below), and `searchSchema`
validates this schema-wide, so a dangling or unsuitable source fails at startup.

The resolved label carries **one word** wherever it surfaces: on the label
source’s own type, on the reference that resolves against it (`dataset { id
label }`), and on a reference facet’s bucket. One word, one meaning – so a
collection reads the same whether you arrive at it directly or through a
reference.

A reference with a label source may additionally declare **`joinable: true`**,
which turns it into an engine-level edge a query can filter across – see
[Filtering across collections](#filtering-across-collections). It is a
capability flag like `filterable` or `facetable`, not something derived from
`labelSource`: a label source added for display costs exactly what it costs
today. Never on an `inline` reference, though: that carries its referent as a
nested object rather than as an id an engine can point a reference at, so the
two are mutually exclusive (`searchSchema` rejects the pair). Carry the referent
inline, or join to its collection – not both.

#### Data on the edge

Sometimes a fact belongs to the _relation_ rather than to either end of it – the
role an agent played, a position, a certainty. A graph states that by putting a
node in between:

```turtle
<work> schema:creator [ schema:name   "etser" ;      # the relation's own value
                        schema:creator <person> ] .  # the endpoint
```

An inline reference nests whatever node its path reaches, so pointed at that
middle node it nests the **edge**, and the edge's own fields are the entry's.
The endpoint is then one hop further out, and a nested reference reaches it:

```ts
const creatorEdge = defineSearchType({
  name: 'CreatorEdge',
  fields: [
    { name: 'role', kind: 'keyword', path: `${SCHEMA}name`, output: true },
    {
      name: 'creator',
      kind: 'reference',
      path: `${SCHEMA}creator`,
      output: true,
      ref: { strategy: 'lookup', target: 'Person', local: true },
    },
  ],
});

const work = defineSearchType({
  name: 'Work',
  class: `${SCHEMA}CreativeWork`,
  fields: [
    {
      name: 'creator',
      kind: 'reference',
      path: `${SCHEMA}creator`,
      array: true,
      output: true,
      filterable: true,
      facetable: true,
      ref: { strategy: 'inline', typeName: 'CreatorEdge', identity: 'creator' },
    },
  ],
});
```

One field, one entry per edge, and the same word for reading, filtering and
faceting:

```graphql
creator { role creator { id name { value } } }
where:  { creator: { in: ["https://id.example/rembrandt"] } }
where:  { creator: { where: { role: { in: ["etser"] } } } }
facets: { creator { value count label { value } } }
```

Two declarations make that work.

**`identity`** names the nested reference whose ids identify each entry. A
nested object is not something an engine can filter or facet, so a reference
declaring `filterable` or `facetable` fans out a flat **identity companion**
holding those ids, which the engine filters and facets in its place. The logical
field keeps one name; only the physical fanout knows there are two. It is
declared rather than inferred – an edge may carry several references, and only
you know which one identifies it – and naming it is also what supplies the
target that types the filter and carries the facet's labels. Both directions are
enforced: `filterable`/`facetable` without an `identity` has nothing to filter,
and an `identity` without either is a companion nothing reads.

Because the companion holds ids only, its facet is **exact**: an endpoint the
source named inline contributes no bucket rather than a bucket keyed on a label,
so two people who share a name are never merged. The cost is stated rather than
hidden – the buckets do not sum to the result count, and that belongs in the
field's [`description`](#describing-a-field).

**`local: true`** on a lookup additionally stores the endpoint's own fields, as
this document states them, projected through the target's own declaration. The
resolved document replaces them at query time – replaces rather than merges, so
a name this document stated in one language cannot survive beside the target’s
name in another. That is what lets one field serve both populations:

| the endpoint            | what the entry carries                               |
| ----------------------- | ---------------------------------------------------- |
| identified, and indexed | its id, and the target's own record                  |
| identified, not indexed | its id, and what this document said – not a bare IRI |
| named inline            | what this document said, and no `id`                 |

Without `local`, an endpoint the source named inline is invisible: a reference
stores IRIs and it has none. Local fields are stored unconditionally rather than
only where there is no id, because the two failures differ – at index time the
question is _is this endpoint identified_, at query time it is _is that document
indexed_.

Note that the displayed name may not be the name a filter matches: the nested
fields are indexed as this document states them, while the resolved document
carries the target's own. Where a target is enriched from an authority the two
differ systematically. Free text covers the gap.

Framing reaches as far as the declaration does – path traversal, inline nesting,
the target's own fields a `local` lookup reads off the endpoint, and the extra
hop a keyed target's document key needs – so an endpoint two hops out is in the
frame. See
[ADR 24](../decisions/0024-carry-data-on-a-reference-edge).

**Conditions inside one edge's `where` are welded to one entry.** `creator: {
where: { creator: { in: […] }, role: { in: ["etser"] } } }` means _this person
in this role_, not _this person somewhere and this role somewhere_ – which two
different entries could satisfy between them. The rule in one line: inside one
edge's `where`, the same entry; across `and`/`or` clauses, anywhere in the
document.

Welding on identity needs the endpoint's `filterable`, which fans out its id as
a leaf beside the stored object – an engine welds conditions on an entry's own
leaf fields only. That is a physical detail: you write the logical field.

**A weldable leaf is single-valued.** A nested field declaring `filterable` may
not also declare `array`; `searchSchema` refuses it. A weld asks whether _one_
entry satisfies every condition, and an entry holding a list stands for each
combination at once – so it answers the weld with none of them, and the weld
degenerates into the cross-product it exists to exclude.

Multiplicity belongs to the entry list instead. Where the graph gives an edge
several roles or several endpoints, the projection emits **one entry per
combination**:

```jsonc
// the graph
{ "role": ["etser", "etcher"], "creator": ["p1", "p3"] }

// the entries
[ { "role": "etser",  "creator_id": "p1" },
  { "role": "etser",  "creator_id": "p3" },
  { "role": "etcher", "creator_id": "p1" },
  { "role": "etcher", "creator_id": "p3" } ]
```

Nothing is dropped, and each entry now answers the weld. Two consequences worth
knowing when you declare an edge:

- A role stated once per language is **one** role, not two. Index its canonical
  IRI single-valued and resolve labels at the surface; declaring the label
  multi-valued makes fan-out emit an entry per language and splits one role
  across two facet buckets.
- An `output`-only nested leaf is untouched by all of this: nothing welds it, so
  it may carry a list for display.
- Fan-out is **not yet bounded**. An edge with pathologically many values
  multiplies into as many entries; the bound belongs at the framing seam, where
  the values enter memory, rather than on the product
  ([#826](https://github.com/ldelements/lde/issues/826)).

See [ADR 26](../decisions/0026-fan-out-a-qualified-edge-into-one-entry-per-tuple).

Out of scope for now: faceting an edge's own values, which the current engine
cannot serve correctly.

#### Naming the label field

That word is `label` by default, but a type may name its own display field with
`labelField`, so the surface word is the profile’s rather than one an internal
role imposes. [SCHEMA-AP-NDE](https://docs.nde.nl/schema-profile/), for
instance, models display names as `schema:name` on `Person`, `Organization`,
`Place` and `DefinedTerm`, and consumers expect them served as `name`:

```ts
const term = defineSearchType({
  name: 'Term',
  class: `${SCHEMA}DefinedTerm`,
  labelField: 'name',
  fields: [
    {
      name: 'name',
      kind: 'text',
      locales: ['nl', 'und'],
      path: [`${SCHEMA}name`],
      output: true,
      searchable: { weight: 4 },
    },
  ],
});
```

The named field must still be an `output`, `searchable` text field – the rules
are the label field’s, not the word’s – and a reference resolving against this
type serves `theme { id name }`. `labelField` is ignored for a type nothing
resolves labels from; without it, everything keeps serving `label`. A facet
bucket’s `label` is unaffected: it is per-facet-field, and a per-type name would
make the bucket shape non-uniform.

### Document key

A Root Type is keyed on the node’s IRI unless it names a **`key` field** to read
the key from. `key` has the shape of `labelField` – _which field is the label_ –
and says _which field holds the key_:

```ts
const place = defineSearchType({
  name: 'Place',
  class: `${SCHEMA}Place`,
  labelField: 'name',
  key: {
    field: '_sameAs',
    // A preference order, not a filter: GeoNames first, then any other source
    // an authority can resolve; nothing matched keeps the publisher’s node.
    pick: (candidates) =>
      candidates.find(isGeoNames) ?? candidates.find(isCovered),
  },
  fields: [
    {
      name: 'name',
      kind: 'text',
      locales: ['nl', 'und'],
      path: `<${SCHEMA}name>`,
      output: true,
      searchable: { weight: 3 },
    },
    {
      // Internal (no role): read for the key, pruned before the writer.
      name: '_sameAs',
      kind: 'reference',
      array: true,
      path: `<${SCHEMA}sameAs>`,
      transform: normaliseIri,
    },
  ],
});
```

- **`key.field`** names a declared field of the type: a `path`-bearing, `array`
  reference field that is not `inline`. Its values are the key candidates.
  Because it is an ordinary field, everything that already applies to fields
  applies to the candidates – it is extracted like any field, a reader transform
  that repairs reference values covers it, and the field’s own `transform` is
  where IRI normalisation lives, so two spellings of one IRI become one
  candidate before anything chooses between them.
- **`key.pick`** chooses among the candidates: `(candidates) => key | undefined`,
  where `undefined` keeps the node’s own IRI. It defaults to the first candidate,
  and is not consulted for a node whose key field is empty.
- **The guards.** Candidates reach `pick` transformed, IRI-filtered, deduplicated
  and **sorted**, so the default is deterministic whatever order the CONSTRUCT
  returned them in. `pick` must return one of them or `undefined` – anything else
  throws, naming the node and its candidates – so a key is always an IRI the
  graph offered for that node. And `pick` must be **pure**: the same function
  keys the document and every reference to it.

`documentKeyOf` (from `@lde/search/adapter`) is that whole rule in one function,
for a transform that needs to know a node’s key before the projection runs.

Two consequences are not new rules, only what a document key already means:

- **Several nodes with one key are one document.** The writer upserts by `id`. A
  deployment that wants the merged document to carry particular content attaches
  a transform; one that does not gets last-writer-wins, exactly as a shared
  entity across datasets behaves today.
- **A reference stores the target’s key.** A `lookup`’s `target` and an
  `idOnly`’s `labelSource` already mean _this field holds ids of documents in
  that collection_ – the contract a label lookup and a join rely on – so a
  reference that names a keyed target stores the referent’s key rather than its
  node IRI. A reference that names no target is never rewritten: it claimed
  nothing about a collection. The extraction adds one `OPTIONAL` hop per such
  reference to read the referent’s key field, so an unaligned referent keeps its
  row and its own IRI.

What LDE deliberately does not know is _why_ one candidate is preferred over
another, and what a merged document should say. **LDE decides the key; the
deployment decides the content.**

Things to keep in mind when declaring one:

- A transform that **replaces** a root’s quads must re-emit the key field – the
  existing rule that a field the document needs must be in the stream, applied to
  one more field. A transform that only adds never meets that rule, but a
  transform that **supplies** key candidates has a mirror of it: a transform is
  attached to one type’s reader, and a reference’s key is read in the referring
  type’s query, so candidates minted on the target alone leave every reference
  keyed on the node IRI. See
  [Add a transform](./search-indexer#add-a-transform).
- The key is assigned **before any `derive` runs**, so a derive sees the key and
  never the node IRI. A deployment that wants the node IRI declares a plain
  `idOnly` reference over the same path.
- The **referring** field’s own `transform` runs on what it stores, which for a
  keyed target is the key rather than the referent’s node IRI. Declare the two
  together only deliberately.
- A work in dataset A referencing a node **in dataset B** gets no candidates (the
  hop runs against A’s distribution), so it stores the node IRI and does not
  resolve against B’s keyed document. Publishers reference each other through
  `sameAs` rather than directly, and such a reference is already unresolvable
  today for every purpose but labels.

See [ADR 22](../decisions/0022-key-a-root-type-on-a-declared-field).

### Projecting what a lookup carries

A `lookup` declares no field list. What it _fetches_ is named per query, by a
projection on `SearchQuery`, and the GraphQL surface builds that from the
client's selection set – so a lookup fetches what was asked for and no more:

```graphql
creativeWorks { items { dataset { license publisher { label } } } }
```

becomes `resolve: { dataset: { fields: ['license'], resolve: { publisher: {…} } } }`,
which the engine answers with **one batched round-trip per level**: the page's
dataset IRIs are deduped and fetched together, then the publisher IRIs those
name. Omitted, a lookup carries its target's label alone – what every reference
carried before. See [ADR 20](../decisions/0020-resolve-a-references-fields-from-the-targets-own-collection).

Facet buckets are unaffected: a bucket is a value, a count and one label, so it
keeps reading the single field the type designates as its label.

### Describing a field

A field may carry a `description`, which surfaces wherever an API has somewhere
to put it – in GraphQL as the field’s description, so it reaches a consumer in
the playground, in introspection and in an editor rather than in documentation
they would have to know to look for. It appears on the output field and again on
the `where` key of the same name, since a reader filtering by a field is the one
most likely to need telling what it covers.

```ts
{
  name: 'creator',
  kind: 'reference',
  array: true,
  path: '<https://schema.org/creator>',
  output: true,
  filterable: true,
  facetable: true,
  ref: { strategy: 'inline', typeName: 'CreatorEdge', identity: 'creator' },
  description:
    'Every creator, with the role each played. Faceted and filtered by URI, ' +
    'so creators the source names inline are shown and searched but never ' +
    'counted in a bucket.',
}
```

Worth declaring wherever the name is not the whole story – and a coverage gap is
the usual case. Here the facet is keyed on identity, so it counts only the
creators the source identified with a URI: exact, never merging two people who
share a name, and deliberately not summing to the result count. Nothing in the
field’s _name_ says that, and a consumer comparing a bucket count against a
total will otherwise read it as a bug.

The declaration is the only place to say so. The module a served API mounts is
plain data, and there is no hook to annotate the built schema afterwards – so the
sentence written here is the one that reaches the reader.

### Facet buckets

A `FacetBucket` always carries its `value` and `count`; what else it carries is
decided by the facet’s kind, and a surface types the bucket accordingly (see
[bucket types](./search-api-graphql#what-it-builds-per-root-type)).

**`label`** is the engine-resolved canonical **data** label, and appears only
for a **reference** facet with a [label source](#field-model) – the bucket is
IRI-keyed, so without it a consumer has nothing to display. Every other kind
carries none, and this is a rule about the data, not an omission to fill in
later:

- a `keyword` facet’s value is a token or free string whose display the
  consumer owns – its own i18n, or the value itself;
- a `boolean` facet has no data label at all, and no language to negotiate one
  from. Only the consumer knows that `true` means “Met afbeelding”. Its bucket
  additionally carries **`is`**, the value as a real boolean, so it round-trips
  straight into the `is` filter that selects it;
- a range-facet bin carries `min`/`max` instead – see below.

### Facet policy

A Root Type may declare **`facetKeys`**: which of its documents get a facet
bucket, as a predicate over the [document key](#document-key). It is declared
once, on the type, and inherited by every facetable reference that _names_ it –
a `lookup`’s `target`, an `idOnly`’s `labelSource` – the same boundary along
which a reference is re-keyed and a join is drawn (so a `derive`d reference,
which reads no referent, is narrowed by nothing either):

```ts
const place = defineSearchType({
  name: 'Place',
  class: `${SCHEMA}Place`,
  key: { field: '_sameAs', pick: (candidates) => candidates.find(isCovered) },
  // Cross-dataset index: only a key in a covered source gets a bucket, on every
  // facet that references Place – a publisher’s local place is never one.
  facetKeys: { only: isCovered },
  fields: [/* … */],
});
```

_Which `Place` ids deserve a bucket_ is a fact about `Place`, not about each of
the fields that point at it (`CreativeWork.locationCreated`, `Person.birthPlace`,
`Organization.location`, …), so the policy lives on the target: a per-field
declaration would state one rule several times, and forgetting one would
silently reintroduce the buckets on that facet alone. The typical reason is a
**cross-dataset index**: two publishers who both left the same-named place
unaligned yield two buckets with one label, which a consumer cannot tell apart –
while a single-dataset app on its own index wants every bucket. The deployment
knows which it is building, so the choice is an indexing policy, not a query
option; a consumer sees one facet that simply has no local buckets.

**Only the facet narrows.** The referring field keeps every value: a document
still displays the excluded place, and `where: { locationCreated: { in:
[kessel] } }` still matches it exactly. _Facets are discovery, filters are
exact_ – the one place the two deliberately disagree, so state it where your
consumers read.

How it works: for a reference inheriting a policy, the projection writes a
`${name}_facet` companion holding the admitted subset of the field’s values –
taken after the field’s own `transform`, so the policy sees what the field
stores, which for a keyed target is the key – and the engine facets the
companion instead of the field (`physicalFields(field, schema).facet`). The
facet is therefore exact under any bucket cap: the engine never sees an
excluded value. Declaring a policy changes the collection definition of every
type that references the policy’s type; see the
[Typesense adapter](./search-typesense#collection-schema-and-engine) for what
that means for a live collection.

**The failure mode is silence.** A predicate that admits none of a type’s keys
empties every facet referencing that type, with no error: a `Term` aligned to
AAT given the places’ `isCovered`, or – the likelier trap – a type that was
`key`ed _after_ its references were indexed, so the stored values are still
node IRIs. Key a type before declaring a policy over its keys, and give each
type its own predicate rather than reuse another’s.

### Range facets

A facetable numeric field (`integer`/`number`/`date`) may declare
**`facetRanges`**: fixed half-open `[min, max)` bins (a `FacetRange` each), so
the facet returns a histogram – the per-bucket counts a UI slider needs –
rather than one bucket per distinct value. `min` is inclusive, `max`
exclusive, so contiguous bins partition cleanly with no boundary
double-counting; omit `min` (or `max`) for an open-ended bin (`< max`, resp.
`≥ min`). Each bin’s `key` is its stable label, echoed back as the
`FacetBucket` `value`, and the bucket also carries the bin’s declared
`min`/`max` bounds, so it is self-describing – a consumer never hardcodes the
bin formula. Bins are **query-time only**: they shape the facet clause the
adapter compiles per query and have no index impact, so changing them needs no
reindex. Engine-neutral by design – the Typesense adapter emits a `facet_by`
range, an OpenSearch adapter would emit a `range` aggregation.

## Projection

`projectRoots` projects **one root type** over the roots the caller supplies –
the pipeline selector already holds them, so nothing is discovered from
`rdf:type` and a `CONSTRUCT` need emit no type triple. It is fully streaming:
each root’s subgraph is framed one at a time and its document yielded as
produced, so beyond a subject index memory stays flat at scale (framing the
whole graph at once is roughly O(N²)). Duplicate triples are collapsed first,
because some SPARQL engines (e.g. QLever) do not deduplicate `CONSTRUCT` output.
Every predicate a value comes from is read through a field’s `path`; a `derive`
computes only from the document projected so far, so `path` is the whole
statement of what the projection reads. `assertTypeInSchema` guards that
the passed `SearchType` is a member of the schema – the port’s own membership
check – so no schema is ever forged to scope a projection to one type.

**Blank-node roots are not indexable**: a blank node has no stable document
key, so framing skips a blank-node root (and any root absent from the index)
rather than crash. Blank-node subjects still embed fine when _referenced_ from
a root; they just cannot _be_ one – select roots accordingly
(`selectByClass` in `@lde/search-pipeline` already excludes them).

`projectRoots` yields a **bare** `SearchDocument`. Pairing each document with the
`SearchType` it belongs to, so the write side can fan a mixed stream out to
per-type collections, is a routing concern owned by the pipeline glue – see
`@lde/search-pipeline`’s `searchStages` and multi-collection writer – not the
projection. One stage per root type keeps `@lde/search` pipeline-free.

`projectRoots` **consumes the quads once** – a single scan builds the subject
index the roots frame off – and so accepts any `Iterable<Quad>`, not just a
materialized array. A caller merging several readers can pass a chained
generator instead of building a third full array at the projection peak:

```ts
projectRoots(
  (function* () {
    yield* registerQuads;
    yield* dkgQuads;
  })(),
  roots,
  schema,
  DATASET,
);
```

### Projection values

Some things a document should carry are true of the **indexing**, not of the
graph. The dataset an entity was indexed from is the case that matters: every
indexed document comes from exactly one, and for the entity types that carry no
containing-collection property – `Person`, `Organization`, `Place`, `Term` – it
is the only available answer to _which dataset does this come from_, because
nothing in the data says it.

A `keyword`/`reference` field declares itself over such a value with `from`
instead of a `path` or a `derive`. The logical name is the deployment’s to
choose, and the field behaves like any other: `output`, `filterable`,
`facetable`, and – as a `reference` – a `labelSource` that resolves the IRI to a
readable label at query time, so a dataset facet arrives with names rather than
URIs.

```ts
const PERSON = defineSearchType({
  name: 'Person',
  class: 'http://schema.org/Person',
  fields: [
    {
      name: 'label',
      path: 'http://schema.org/name',
      kind: 'text',
      locales: ['nl'],
      output: true,
      searchable: { weight: 5 },
    },
    {
      name: 'dataset',
      kind: 'reference',
      from: 'dataset',
      output: true,
      filterable: true,
      facetable: true,
      labelSource: 'Dataset',
      ref: { strategy: 'lookup', target: 'Dataset' },
    },
  ],
});
```

The value reaches the projection through `projectRoots`’ **projection context**;
`@lde/search-pipeline`’s `searchStages` supplies it from the batch’s dataset, so
a deployment declares the field and nothing else. Every `derive` receives the
same context as its second argument, which is what lets a derive relate a
projected value to its provenance – dropping a polymorphic `isPartOf` value that
merely points back at the containing dataset, say:

```ts
{
  name: 'isPartOf',
  kind: 'reference',
  array: true,
  output: true,
  ref: { strategy: 'lookup', target: 'CreativeWork' },
  // `partOfRaw` is an internal field over schema:isPartOf
  derive: (document, context) =>
    (document.partOfRaw as string[] | undefined)?.filter(
      (value) => value !== context.dataset,
    ),
}
```

Projecting without a context is legitimate (a test, a one-off): the field is
simply left unpopulated, exactly as a `path` that matched nothing would be.

A declared dataset field is also what the engine writer keeps its **provenance
bookkeeping** on – see [`@lde/search-typesense`](./search-typesense.md#provenance)
– so the facet, the label, any derive and the membership sweep read one column
rather than two copies of one IRI.

## Locales

`locales` declares the languages a `text` field wants **indexed** (`und` =
untagged literals). It drives the two per-locale, in-memory fanouts –
`searchable` and `sortable` – but **not** display, which preserves every
language present:

- `output` → `title_<lang>` for **every** language the data carries (`title_nl`,
  `title_en`, `title_fr`, `title_und`, …), accents preserved. Display is stored
  `index: false` (on disk, off RAM), so extra languages cost nothing – a value
  in a language outside `locales`, or an untagged one, still renders rather than
  collapsing to a bare IRI. One un-indexed regex field (`${name}_<lang>`, see
  `displayFieldPattern`) captures them all;
- `searchable` → `title_search_nl`/`title_search_en` (folded; one field per
  locale lets a query `query_by` them and rank the user’s language higher, and
  lets a language that needs a dedicated tokenizer set its own stemming `locale`
  in the engine schema);
- `sortable` → `title_sort_nl`/`title_sort_en` (folded, so a locale-switching UI
  sorts on the active language). Each locale’s key **falls back** to the
  document’s first value in `locales` order when that language is absent, so a
  document titled only in English still sorts under a title in a Dutch request.
  A sort names a single key: without the fallback every document lacking the
  active language would tie on the empty string and come back in relevance
  order, which is what a collection of untagged titles looks like when it is
  “sorted” by name. Search needs no such fallback – a query fans out over every
  locale key at once.

A field with `searchable` but no `output` is **search-only** – folded and stemmed
for retrieval but never rendered (e.g. a creator searched here but shown via a
separate label). **Only listed locales are indexed** (searched and sorted); a
literal whose language tag is not in `locales` is still **displayed** but not
matched or sorted on. Display fields are **omitted, never empty**, when a document
lacks that language, and the per-locale search fields likewise, so declare them
optional in the engine schema and sort with `missing_values: last`. A sort field
is present whenever the field holds any value in a declared locale (the fallback
above); it is absent only when the field is. A
deployment that wants to bound the displayed languages narrows them upstream
(e.g. selecting a language subset in its CONSTRUCT query), since preservation is
the default.

Folding the search fields is what lets diacritic-insensitive matching and
stemming coexist. A search engine on its **default** locale typically folds case
and diacritics for you; enabling a language’s **stemming** switches it to ICU
tokenization, which **preserves** diacritics – at which point `fold()` (from
[`@lde/text-normalization`](./text-normalization)) is what keeps matching
diacritic-insensitive. Stemming is rules-based and can mangle proper nouns (the
Dutch stemmer reduces the city `Bergen` to `berg`), so enable it on free-text
fields and keep proper-noun facets on a separate, unstemmed field.

## Querying

The search fields are stored already case- and diacritic-folded, so **the query
must be folded the same way** with the same `fold()` before it reaches the engine,
or index and query normalize differently and matches silently miss. This contract
holds for **any** consumer, including an API built on this package – which is why
engine adapters and surfaces compile through the shared `SearchQuery` IR and the
`physicalFields` convention rather than re-deriving field names.

Queries are **always validated**: the port contract requires every engine
adapter to reject a structurally invalid `SearchQuery` (`assertValidQuery`) –
unknown or non-`filterable` fields in `where` (bar `id`, filterable on every
type – see [Lookup by IRI](#lookup-by-iri)), an operator not matching the
field’s kind, non-`facetable` facet requests – no matter which surface or
policy produced it. A typed surface like GraphQL makes most of these
unrepresentable; the port enforces them for everyone else (deployment
`queryDefaults`, in-process callers, weaker-typed surfaces).

One rule is about a **value** rather than a field: a `date` range bound the
storage codec cannot read (`'yesterday'`, or a year past the ±271,821 window
`Date` covers) is an `unparseable-bound` issue naming the rejected bound. No
surface’s type system catches this – `String` is `String` – and it has to be
caught here because a compiler cannot recover what the caller meant: a rejected
bound is indistinguishable from a bound never set, and inside an `or` the two
readings pull opposite ways – read as unset it widens the range to unbounded,
dropped it narrows the result to the criterion’s siblings. Only the caller can
fix the bound, so validation hands it back to them instead of guessing.

Validation is the guard, but it is not the only one: a compiler reached
directly must not quietly answer a different question either. So a `where`
clause the Typesense compiler cannot compile is treated by **what it means**,
not by the fact that it produced no term. A clause that states no constraint
(an empty `in`, a `range` with no usable bound) is _true_ and leaves the query;
a clause whose every criterion is malformed or unsatisfiable is _false_ and
compiles to a term no document matches, so the search comes back empty. The
difference only shows up in the `&&` between clauses – dropping a false clause
would delete a conjunct and hand back everything the remaining clauses allow –
and it is why a filter language needs a way to say “nothing”, which `filter_by`
spells as the empty identity membership `id:=[]`. Either way the clause is
reported to `onIgnoredFilter`, since neither compiled as written.

### Lookup by IRI

Every type is filterable on **`id`** – the document’s key, which is the node’s
IRI unless the type declares a [`key` field](#document-key) – without declaring
it, and every surface returns it. It is the one field no `SearchType` declares,
because every indexed thing already carries it: it is the hit’s identity
(`SearchHit.id`), not a value in its `ResultDocument`. `searchSchema()` rejects
a declared field named `id` (`reserved-field-name`) so nothing can shadow it.

Membership only – an IRI has no range and no truth value – so a lookup is also a
batch lookup:

```graphql
{
  organizations(where: { id: { in: ["https://id.drapo.nl/ffed9f91-…"] } }) {
    items {
      id
      name {
        value
      }
    }
  }
}
```

This is what makes an IRI a usable entry point: a client holding a reference’s
`id` (from `publisher`, `isPartOf`, `creator`, …) fetches that entity’s own
fields from its own collection, rather than the schema having to carry them
inline on every referring document.

### Matching a value in any of several fields

Filters you write side by side must **all** match:

```graphql
where: { material: { in: ["https://vocab.getty.edu/aat/300015050"] }, status: { in: ["valid"] } }
```

When you want a value matched in **any** of several fields instead, put those
alternatives under `or`. This is the query behind an entity page – “everything
related to Van Gogh”, where the link may be recorded as `creator`, `contributor`
or `publisher` depending on the source:

```graphql
query Related($agent: PersonFilter!) {
  heritageObjects(
    where: {
      material: { in: ["https://vocab.getty.edu/aat/300015050"] }
      or: [{ creator: $agent }, { contributor: $agent }, { publisher: $agent }]
    }
  ) {
    pagination {
      total
    }
    facets {
      material {
        value
        count
      }
    }
  }
}
```

You get one search, so `total`, the ranking and the facet counts are all correct
– where issuing a query per field and merging the results client-side would lose
each of them.

Add `id` to the alternatives to include the entity’s **own** record alongside
everything referring to it – `or: [{ id: $work }, { isPartOf: $work }]` asks for a
work together with its parts.

Note what the alternatives have in common: they all accept IRIs **of the same
type**, so one variable serves them all. That is not a coincidence – it is what
[the GraphQL surface](./search-api-graphql#finding-which-fields-accept-an-iri)
lets a consumer discover: given a collection, which fields of which collections
accept its IRIs. Fields pointing at _different_ targets carry different filter
types, and since GraphQL checks variable usage nominally, each needs its own
variable.

Three things to know when writing `or`:

- **It sits alongside your other filters**, which still all apply. Above, every
  hit is an oil painting _and_ related to the agent.
- **Each alternative names one field.** `{ creator: $a, about: $b }` in a single
  entry is rejected by the schema – write it as two entries.
- **A field may appear more than once**, which is how you ask for two ranges on
  one field: `or: [{ created: { max: "1800" } }, { created: { min: "1900" } }]`.

Any kind of field can take part, not just references: `or: [{ material: $m },
{ technique: $m }]` works the same way.

#### Asking for two `or` groups at once

A `where` takes one `or`. When you need two independent sets of alternatives –
an agent recorded either way, _and_ a place recorded either way – list them under
`and`:

```graphql
where: {
  and: [
    { or: [{ creator: $agent }, { contributor: $agent }] }
    { or: [{ contentLocation: $place }, { locationCreated: $place }] }
  ]
}
```

That is the only thing `and` is needed for. For plain filters it changes nothing,
since side-by-side keys already all apply – these are the same query:

```graphql
where: { status: { in: ["valid"] }, material: { in: ["https://vocab.getty.edu/aat/300015050"] } }
where: { and: [{ status: { in: ["valid"] } }, { material: { in: ["https://vocab.getty.edu/aat/300015050"] } }] }
```

#### Facet counts under an `or`

Your facets keep describing the results you are showing. A facet normally ignores
the filter on its own field, so you can still see – and pick – its other values.
An `or` spanning **several** fields is not any one field’s filter, so it applies
to every facet: on the query above the `material` facet counts within the Van
Gogh–related set, and a `creator` facet lists Van Gogh alongside the other
creators in that set, each with the count you would get by picking it.

An `or` whose alternatives all name the **same** field is a selection on that
field, so its own facet ignores it like any other filter – you still see the
other values you could pick, not just the ones already selected.

One thing to watch: an alternative that constrains nothing – an empty `in`, say
a facet variable with nothing selected – makes the whole `or` match everything,
because “no constraint OR anything” is no constraint. If you build alternatives
from optional inputs, leave the unset ones out of the list rather than passing
them empty.

Since `and` and `or` are `where` keys, a `SearchType` cannot declare a field
called `and` or `or`; `searchSchema()` rejects it, as it does `id`.

Underneath, each of these compiles to one `Filter` – `{ or: [Criterion, …] }` –
in the query IR, and the whole `where` to a single engine query. See
[ADR 18](../decisions/0018-filter-across-several-fields-with-one-clause.md).

Two consequences of treating identity as its own kind of filter:

- **An empty `in` on `id` matches nothing**, where an empty `in` on any other
  field is a no-op the compilers skip. An identity filter enumerates the
  documents wanted, so the empty set wants none; a value filter constrains a
  dimension, so an empty set constrains nothing (a facet UI with nothing
  selected sends exactly that). `isUnsatisfiable` reports the case, and an
  adapter must answer it with an empty result instead of dispatching – otherwise
  a client mapping a possibly-empty reference array into a lookup gets the whole
  collection. Facets for such a query are empty too.
- **The batch is bounded by the request, not by a URL.** The Typesense adapter
  sends every query – root search, facet batch, label lookup – as a
  `multi_search` POST, so a long `filter_by` cannot overflow the 4000-character
  GET query-string limit that a few dozen IRIs would breach.

Keep `id` distinct from a domain identifier. `id` is _what the thing is_; a
declared field like `identifier` (`schema:identifier`) is _what a source system
calls it_ – an inventory or catalogue number. Both may exist on one type; they
answer different questions.

### Filtering across collections

Each root type has its own collection, so “every object published by institution
X” used to mean two queries: list the institution’s datasets, then ask for the
objects of each – losing a correct `total`, ranking and facet counts on the way.

Declare the edge and it becomes one query. A `reference` with a `labelSource`
already asserts that its values are ids of documents in that type’s collection;
`joinable: true` lets the engine use that assertion:

```ts
{ name: 'dataset',   kind: 'reference', filterable: true,
  labelSource: 'Dataset',   joinable: true },   // on CreativeWork
{ name: 'publisher', kind: 'reference', filterable: true,
  labelSource: 'Publisher', joinable: true },   // on Dataset
```

A joinable reference then takes a richer filter on the surface – its ids, **or**
a condition on the referent, nested as deep as the edges go:

```graphql
{
  creativeWorks(
    where: {
      dataset: {
        where: { publisher: { where: { id: { in: [$institution] } } } }
      }
    }
  ) {
    pagination {
      total
    }
  }
}
```

That is one engine round-trip (`filter_by: $datasets($publishers(id:=X))`), with
a correct `total`, ranking and facet counts. `in` on the same key keeps its
ordinary meaning – the ids the field itself holds, no hop – so the capability is
additive.

In the IR each nested `where` becomes an `on` **path** on the criterion it
produces, never extra clause structure:

```ts
{
  or: [{ on: ['dataset', 'publisher'], field: 'id', in: [institution] }];
}
```

so `where` stays the flat conjunction of disjunctions it was, a joined criterion
can sit inside an `or` beside a local one, and skip-own-filter still works.
Paths are capped at **three hops**.

Four rules come with declaring one, all enforced when the schema is built:

- **`joinable` needs a `labelSource`.** The join addresses the referent’s
  collection, which is the one the label source names.
- **At most one joinable reference per (type, target type).** An engine
  addresses a join by _collection_, not by field, so a second reference to the
  same collection would be indexed and then unreachable. `publisher` and
  `creator` both resolving to `Organization` is the ordinary case, so it is a
  declaration error naming both fields. Drop `joinable` from one – it keeps its
  labels, facets and id filtering.
- **No cycles.** The types a joinable edge connects form a **join component**,
  and a component’s collections must have an order to be created in.
- **A component rebuilds together.** That is the one real cost: see
  [component-scoped rebuilds](./search-typesense#the-join-component-is-the-unit-of-rebuild).
  A type with no joinable edge is a singleton component and is unaffected.

`joinGraph(schema)` is where all of that lives – `components` for a writer,
`resolve(from, path)` for a query compiler. `searchSchema` builds it eagerly, so
a schema whose joins do not hold up fails at startup.

Not yet supported through a join: facets, sorting, free-text search, and the
reverse direction. And one engine-level caveat worth knowing before you deploy:
a component built from scratch needs its **indexer run twice** before its joins
resolve – see
[ADR 19](../decisions/0019-filter-across-collections-through-declared-joins.md)
for that and the other limitations.

Sorting has two deliberate wrinkles. `orderBy` accepts the sentinel field
**`relevance`** – text-match ranking, not a declared field (Typesense compiles
it to `_text_match`). And `validateQuery` allows sorting on **any declared
field**, not only `sortable` ones: `sortable` means _publicly selectable_ in a
surface’s `orderBy` enum, while a deployment policy (`queryDefaults`) may sort
on a private field – say a `statusRank` tie-break the API never exposes.

## Typed results

An engine is **bound to the whole `SearchSchema` at construction** – like
every other schema consumer (`projectRoots(quads, roots, schema, type)`,
`buildGraphQLSchema(schema)`): the adapter factory takes the deployment’s
declaration, so a query can never meet the wrong index, and deployment-level
concerns (the label cache, cross-type search, facet batching) have one home.
Where each type physically lives is the **adapter’s** to decide – it derives a
collection/index name from the type, by its own engine’s naming conventions,
and a deployment only overrides that where it must. A search names its type per
call. Because `searchSchema()` captures the declared types as a literal
tuple, `search()` accepts **only the deployment’s own types** (a foreign type
is a compile error) and returns facet/document keys typed by the type passed
– no caller-side generics:

```ts
// No `collections`: each type reads the collection the adapter names it,
// which is the one its writer builds. Pass `collections` only to override.
const engine = createTypesenseSearchEngine(client, schema);

const result = await engine.search(DATASET, query);
result.facets.publisher; // typed: only DATASET’s facetable fields are keys
result.facets.publsher; // compile error (typo)
result.hits[0].document.title; // typed: only DATASET’s output fields are keys
await engine.search(OTHER_TYPE, query); // compile error: not in this schema
```

`searchFacets(type, queries)` is the port’s **batch entry point**: several
facet-only queries – e.g. a faceted listing’s skip-own-filter variants –
answered in one engine round-trip (Typesense: a single `multi_search`), one
outcome per query, positionally aligned – its facet map, or an in-place error,
so one failed query never discards its siblings’ facets. The same schema
binding, per-query validation and typed facet keys apply to every query in
the batch.

This only works when the types were declared with `defineSearchType` (or
captured `as const satisfies SearchType`) and composed with `searchSchema()`;
a plain `: SearchSchema` annotation widens gracefully to string keys.
`FacetFieldsOf`/`OutputFieldsOf` are exported for annotating your own
signatures, and `engine.schema` exposes the bound declaration for routing.

## Why a declarative model

The vocabulary mirrors SHACL on purpose: `path` is `sh:path`, `array` is
`sh:maxCount`, `required` is `sh:minCount`, `locales` is `sh:languageIn`, `ref`
is `sh:class`/`sh:node`. So the same core that runs a hand-written `SearchSchema`
today will run a **SHACL-generated** one tomorrow – the model, the ports and the
IR stay; only schema-authoring gets automated.
