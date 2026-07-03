# 3. Search API core query model

Date: 2026-06-25

## Status

Proposed

Aligned with the NDE [stack platform docs](https://docs.nde.nl/stack/layers/platform); the
decisions below are reflected there.

## Context

The Dataset Register is moving its browser search off direct Typesense queries onto a
search API, API-first and GraphQL-first (REST deferred). We want the API configured from a
declarative source so the GraphQL surface, a later REST surface, and the index cannot drift
from each other, and so a deployment can swap search engines without consumers noticing.

That requires an engine- and protocol-neutral **core** that both API surfaces and any
engine adapter sit on. The architecture is Ports & Adapters with a framed JSON-LD
intermediate representation, generated from SHACL + a `search:` annotation vocabulary,
scoped here to what a v1 keyword search needs.

## Decision

### Package family

Two tiers: `search-*` is backend you compose; `search-api-*` is the surface you publish.

| Tier        | Package                   | Responsibility                                                                                                          |
| ----------- | ------------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| backend     | `@lde/search`             | field model · `SearchQuery` · filter semantics · engine port                                                            |
| backend     | `@lde/search-typesense`   | engine adapter: collection schema · query/filter compiler · `search()`                                                  |
| API surface | `@lde/search-api-graphql` | field model + `SearchQuery` → GraphQL schema (runtime configuration; see [ADR 4](./0004-search-api-graphql-surface.md)) |
| API surface | `@lde/search-api-rest`    | OpenAPI + route handlers (later, thin over the core)                                                                    |

### Contract frozen, storage swappable

The **API contract** (the SDL shape consumers couple to) is breaking to change and must be
right in v1. The **IR / stored document** (framed JSON-LD vs a flat engine doc) lives
behind the adapter and is swappable with no consumer impact. Nothing engine-specific
(companion fields, `int32`, the engine query language) and nothing RDF-specific
(`@context`, `@id`, IRI-keyed predicates) leaks past the engine port.

### Field model

The engine-neutral description of a queryable field. **One `SearchField` declaration drives
four consumers** – projection (RDF→flat document), the engine collection schema, the query
semantics, and the GraphQL surface – so they cannot drift. SHACL is one possible source
(see the mapping below), not a dependency: a hand-written declaration is just as valid.

It is a **unified** model: a single declaration carries the projection, the collection
schema and search weights, and the query semantics – concerns that would otherwise each
need their own per-field configuration, free to drift apart. `kind` plus independent
capability flags express them all, derived fields are first-class, and the
Typesense-vocabulary types are _derived_ from `kind`, never declared.

```ts
type FieldKind =
  | 'text'
  | 'keyword'
  | 'integer'
  | 'number'
  | 'boolean'
  | 'date'
  | 'reference';

interface SearchField {
  readonly name: string; // logical API name; the physical fanout derives from it
  readonly kind: FieldKind;
  readonly path?: string; // sh:path to project from; omit for a derivation-populated field
  readonly array?: boolean; // sh:maxCount
  readonly required?: boolean; // sh:minCount ≥ 1 — non-null in output, non-optional in the index
  readonly localized?: boolean; // rdf:langString / sh:languageIn (text only)
  readonly locales?: readonly string[]; // when localized: which languages to emit
  readonly output?: boolean; // appears in the schema output type
  readonly searchable?: { weight: number }; // free-text inclusion + weight (per-locale when localized)
  readonly filterable?: boolean; // usable in `where`
  readonly facetable?: boolean;
  readonly sortable?: boolean;
  readonly ref?: { type: string; strategy: 'labelOnly' | 'idOnly' | 'inline' }; // kind: 'reference'
  readonly transform?: (value: string) => string; // projection-time value transform
  readonly facetRanges?: readonly FacetRange[]; // numeric facet: fixed [min, max) range bins (histogram) vs per-value buckets
}

type Derivation = (document: SearchDocument, node: FramedNode) => void;

// One root type (one SHACL NodeShape); a whole deployment’s declaration is the
// SearchSchema, a map of SearchTypes keyed by type IRI (built with searchSchema()).
interface SearchType {
  readonly name: string; // logical API name ('Dataset') – names the type in every surface,
  // declared (like each field's name), never derived from the IRI, so vocabulary
  // churn cannot silently rename the public contract
  readonly type: string; // sh:targetClass
  readonly fields: readonly SearchField[];
  readonly derivations?: readonly Derivation[]; // computed fields: status, booleans
}
```

Maps onto SHACL + `search:` (`kind`←`sh:datatype`/`sh:nodeKind`, `path`←`sh:path`,
`array`←`sh:maxCount`, `localized`←`sh:languageIn`, `facetable`←`search:facetable`,
`sortable`←`search:sortable`, `ref`←`sh:node`/`sh:class` + `search:nestedStrategy`) so an
eventual generator emits it unchanged. A field with **no `path`** is a derived field –
populated by a `Derivation` rather than projected from the IR – yet it still carries full
query/schema/output behavior. The physical field names a declaration fans out to (`${name}_search_${locale}`,
`${name}_sort_${locale}`, `${name}_search`) follow one convention owned by
`@lde/search`, so projection, collection schema and query compiler agree. The `status_rank`
tie-break sort is a **deployment-specific delta**, never in `@lde/search`. Grouped facets need
no field-model mechanism at all: a deployment derivation materializes group tokens (e.g.
`group:rdf`) into the field’s own values – see Consequences. `relevance` is _not_ a delta:
every full-text engine ranks by match score, so it is a generic reserved sort the adapter
understands.

### `SearchQuery` – the neutral query IR

Both surfaces compile input into this; the adapter compiles it into an engine query. One
shared representation in the middle keeps GraphQL and REST from drifting.

```ts
interface SearchQuery {
  readonly text?: string; // undefined/'' = browse
  readonly where: readonly Filter[]; // AND across fields
  readonly orderBy: readonly Sort[];
  readonly limit: number; // numbered pagination
  readonly offset: number;
  readonly facets: readonly string[];
  readonly locale: string; // from Accept-Language; selects per-locale fields
}

type Filter =
  | { readonly field: string; readonly in: readonly string[] } // keyword membership, OR within field
  | {
      readonly field: string;
      readonly range: { min?: number | string; max?: number | string };
    }
  | { readonly field: string; readonly is: boolean };

interface Sort {
  readonly field: string;
  readonly direction: 'asc' | 'desc';
}
```

`locale` drives query-side field selection only; output language ordering is a surface
concern. Deployment defaults (e.g. status=valid, default sort) are consumer policy applied
when building the query, not baked into the core.

Sorting has two tiers. A field’s `sortable` flag marks it **publicly selectable** in the
surface’s `orderBy`, alongside the generic `relevance` – so a user can sort by `relevance`
(the sane default when there is a query) or by any sortable field (title, date, size). The
adapter can _additionally_ sort by any indexed field a deployment’s `queryDefaults`
references – e.g. DR’s `status_rank` tie-break – which is never exposed as a public sort
option.

The public `orderBy` is a **single** primary sort; the surface composes it with the server
tie-break(s) into this internal `Sort[]`. A client-supplied array can be added
later, but it is backward-compatible only for inline-literal clients (list input coercion);
variable-based clients (`$o: DatasetOrderBy`) break, so a future array is a deliberate change.

### Filter semantics

| `kind`                        | `where`                          | facet         | sort            |
| ----------------------------- | -------------------------------- | ------------- | --------------- |
| `text`                        | – (feeds `text`)                 | –             | yes (localized) |
| `keyword` / `reference`       | `in` (exact membership)          | yes           | –               |
| `integer` / `number` / `date` | `range { min?, max? }` inclusive | range buckets | yes             |
| `boolean`                     | `is`                             | yes           | –               |

**Inclusive bounds only** – `min`/`max`, no `gt`/`gte`/`lt`/`lte`: self-documenting,
matches Typesense’s native inclusive range, covers every DR case, additively reversible.
A numeric facet returns **range buckets** (`[min, max)` bins declared per field); the adapter
maps them to the engine’s native range faceting.

**Grouped facets need no special engine mechanism; they are denormalized at index time.**
A coarse category alongside granular values (e.g. `group:rdf` next to media types, `group:person`
next to class IRIs) is materialized into the field’s own values during projection, so at query
time a group token is an ordinary value: faceted natively, filtered by plain membership
(`field.in: ["group:rdf"]` unions with granular values for free), and — where the field is
`output` – read like any other value. There is no `_group` companion, no `group:`-prefix split,
no filter rewriting in the adapter; the engine stays dumb and denormalization (the document
store’s strength) does the work. A cross-source signal that is not a subset of the field (e.g. a
SPARQL capability derived from `conformsTo`, not a media type) is likewise materialized as a plain
value by a deployment derivation.

The trade-off this design accepts: **group membership is fixed at index time.** Because the
group token is baked into each document’s values during projection, redefining a group (which
granular values map to `group:rdf`) is an index-data change that takes effect only on **reindex** –
there is no query-time mapping to edit. The constraint is acceptable here because group definitions
are deployment projection config that already drives indexing, and reindexing is already the
pipeline’s job; it would not suit a system where grouping is user-defined or changes frequently.

### Engine port and result

The **port** is the interface the core defines; a concrete engine **adapter**
(`@lde/search-typesense`’s `TypesenseSearchEngine`) implements it. Naming the port for the
capability (`SearchEngine`), not the pattern piece, keeps `TypesenseSearchEngine implements
SearchEngine` readable.

```ts
// FacetField / OutputField default to `string` (ergonomic) and a deployment narrows them
// to its type’s facetable / output field names for typo-safe facet and document access;
// Type narrows the accepted searchType argument alongside, so a narrowed engine cannot be
// handed the wrong search type. The ergonomic route is engineFor(searchType, engine) over
// a defineSearchType declaration (helpers FacetFieldsOf<Type> / OutputFieldsOf<Type> and
// the EngineFor<Type> alias are exported for hand-written signatures).
interface SearchEngine<
  FacetField extends string = string,
  OutputField extends string = string,
  Type extends SearchType = SearchType,
> {
  search(
    query: SearchQuery,
    searchType: Type,
  ): Promise<SearchResult<FacetField, OutputField>>;
}

interface SearchResult<
  FacetField extends string = string,
  OutputField extends string = string,
> {
  readonly hits: readonly SearchHit<OutputField>[];
  readonly total: number;
  // Keyed by facet field name; `Partial` because only the queried facets are present.
  // A bucket’s `label` (a LocalizedValue) is the engine-resolved canonical data label,
  // present only for reference (IRI-keyed) facets; absent for token/free-string facets,
  // whose display the consumer owns (its own i18n, or the value itself).
  readonly facets: Readonly<
    Partial<
      Record<
        FacetField,
        readonly { value: string; count: number; label?: LocalizedValue }[]
      >
    >
  >;
}

// `id` (the stable document key, an IRI) stays out of the document: it is the hit’s
// identity, always present, a different contract from the optional logical field values,
// and maps straight onto the GraphQL output’s `id: String!`.
interface SearchHit<OutputField extends string = string> {
  readonly id: string;
  readonly document: ResultDocument<OutputField>;
}

// The logical result document. Named distinctly from the flat, fanned-out projection
// `SearchDocument` that lives index-side: this carries logical fields (language maps,
// references) ready for a surface to shape.
type ResultDocument<OutputField extends string = string> = Readonly<
  Partial<Record<OutputField, SearchValue>>
>;
type SearchValue =
  | string
  | number
  | boolean
  | readonly string[]
  | LocalizedValue
  | Reference
  | readonly Reference[];
type LocalizedValue = Readonly<Record<string, readonly string[]>>; // language map; `und` = @none
interface Reference {
  readonly id: string;
  readonly label?: LocalizedValue;
}
```

The adapter owns all engine specifics (companion-field expansion, `query_by`/weights, the
filter compiler, `sort_by`, folding, `facet_by`) and returns only logical documents.

`Reference` here is the generic _internal_ carrier; the GraphQL surface maps it to named
per-shape types (e.g. `Organization`, `Term`) with `label` exposed as `name`
(see [ADR 4](./0004-search-api-graphql-surface.md)).

### Localized representation: map in the IR, best-first list at the surface

- **IR / adapter-return:** JSON-LD language map (`@container: @language`), `@set` arrays,
  `und` for untagged. Matches schema-profile #171 (language maps are more usable as a data
  model) and the stack platform envelope.
- **GraphQL surface:** a single **best-first** `Accept-Language`-ordered list
  (`[LanguageString!]!`, see [ADR 4](./0004-search-api-graphql-surface.md)). `[0]` is the
  value to display; **`[0].language` is the language actually served** – the per-field
  equivalent of HTTP `Content-Language`, so a client detects a fallback
  (`[0].language !== requested`) and sets the right `lang`. `language` is nullable for
  untagged (`@none`) values; the rest of the list is the available-languages set (switcher /
  discovery).

Preference is driven **solely by the `Accept-Language` header** – any HTTP client sends it
(not just browsers), one mechanism across GraphQL and REST. No per-field or root `language`
argument (deferred): a parallel arg would duplicate the header and need precedence rules.

Chosen over a `{nl,en}` map (silently yields `undefined` for a missing language, no defined
fallback order) and over a separate resolved scalar (the value must be a `LanguageString` to
carry its language anyway, so the scalar saved only the `[0]` index – not worth a second
field plus diverging from the Network-of-Terms list shape). Grounded in measured
data and all three substrates:

- **A (descriptions, measured):** bilingual `nl`/`en`, ~86% Dutch-only → an English user gets
  a tagged Dutch fallback ~86% of the time; the `Content-Language` tag is load-bearing. Zero
  untagged in the valid set.
- **B (objects):** untagged proper names (Person/Place) → the nullable `language` earns its keep.
- **C (terminology):** labels in many languages → long ordered lists.

**Deferred (note only):** filtering by _metadata-language availability_ (e.g. records that
have an English title) is distinct from content `dct:language` (already filterable) and from
preference; expressible as a facetable dimension (languages-present-in-a-localized-field),
not enabled for DR v1, more relevant for B/C.

### Other decisions

- **Numbered pagination** (`offset`/`limit`, presented as page/per-page), not Relay
  cursors. DR is a page-numbered faceted browser with totals; Typesense is natively
  page/per-page; the ~2,500-doc corpus never paginates deep enough for offset cost to bite;
  and the blue/green alias swap removes the mutation-drift that motivates cursors.
- **Sidecar canonical labels**, not inline `labelOnly` as default. Facets need one
  canonical label per entity, kept in a separate collection — DR’s `labels` collection. A
  reference’s `strategy` is carried as metadata; `labelOnly` is the v1 default, not inline.
- **Logical typed result document** at the query seam; framed JSON-LD kept index-side as the
  index/projection artifact (its payoff – vector/LDES/UI sinks – is object-search’s, not
  catalog-search’s), gated on the generic framing packages existing rather than on DR.

## Consequences

- One declarative source drives GraphQL, later REST, and the index; they cannot drift.
- The engine is a swappable adapter; the contract outlives engine choices.
- Folding (case/diacritics) happens at the adapter boundary and on the query side via
  `@lde/text-normalization`, so index and query normalize identically.
- Deferred: REST surface; framed-JSON-LD materialised view (nested storage, index-time
  label inlining, detail-page-on-index, terms-collection split); semantic/hybrid (vector)
  search.
