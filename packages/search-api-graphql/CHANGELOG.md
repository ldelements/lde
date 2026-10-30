## 0.38.0 (2026-10-30)

### 🚀 Features

- ⚠️  **search-api-graphql:** count a query’s cost in engine operations ([#971](https://github.com/ldelements/lde/pull/971))

### ⚠️  Breaking Changes

- **search-api-graphql:** count a query’s cost in engine operations  ([#971](https://github.com/ldelements/lde/pull/971))
  maxCost and MAX_COST now count engine operations instead of
  graphql-armor shape points, and the default drops from 5000 to 100. Re-tune any
  configured value: 5000 no longer limits anything. A query over the limit now fails
  with an execution error (HTTP 200) instead of a validation error (HTTP 400).
  * docs: ground the maxCost default in measured query costs
  - Record that LOL’s costliest creativeWorks query costs 48 and the Dataset Register
    browser’s listing query 9, against the default of 100
  * fix(search-api-graphql): count skipped selections in the query cost
  - Charge a selection under @skip or @include whatever its condition: the projection does not
    evaluate those directives, so the engine fetches skipped lookups too
  - Name the per-target lookup cost in the rejection message
  - Correct the comment on how yoga masks a failed measurement"
  M	docs/decisions/0014-serve-the-search-graphql-api-with-graphql-yoga.md
  A	docs/decisions/0031-count-a-querys-cost-in-engine-operations.md
  M	docs/reference/search-api-graphql.md
  M	docs/reference/search-api-server.md
  M	package-lock.json
  M	packages/search-api-graphql/package.json
  M	packages/search-api-graphql/src/build-schema.ts
  M	packages/search-api-graphql/src/handler.ts
  M	packages/search-api-graphql/src/max-searches.ts
  A	packages/search-api-graphql/src/query-cost.ts
  M	packages/search-api-graphql/test/handler.test.ts
  A	packages/search-api-graphql/test/query-cost.test.ts
  M	packages/search-api-graphql/vite.config.ts

### 🧱 Updated Dependencies

- Updated @lde/search to 0.34.0

## 0.37.0 (2026-10-28)

### 🧱 Updated Dependencies

- Updated @lde/search to 0.33.0

## 0.36.3 (2026-10-28)

### 🩹 Fixes

- **search:** read deep-time years beyond Date as xsd:gYear ([#967](https://github.com/ldelements/lde/pull/967))

### 🧱 Updated Dependencies

- Updated @lde/search to 0.32.3

## 0.36.2 (2026-10-28)

### 🧱 Updated Dependencies

- Updated @lde/search to 0.32.2

## 0.36.1 (2026-10-26)

### 🧱 Updated Dependencies

- Updated @lde/search to 0.32.1

## 0.36.0 (2026-10-26)

### 🧱 Updated Dependencies

- Updated @lde/search to 0.32.0

## 0.35.0 (2026-10-25)

### 🚀 Features

- ⚠️  **search:** count a facet without its own filter in the engine, keeping its selection ([#932](https://github.com/ldelements/lde/pull/932))

### ⚠️  Breaking Changes

- **search:** count a facet without its own filter in the engine, keeping its selection  ([#932](https://github.com/ldelements/lde/pull/932))
  a SearchEngine must count each facet without its own where clause and
  report the values that clause selects, so search() with facets and filters returns different
  buckets than before.
  * docs(search): rewrite the skip-own-filter decision record for readers new to it
  * docs(search): state that search() fails as a whole, and why that is accepted
  * fix(search): merge a counted selected value among its facet’s buckets by count
  - Sort a value counted outside a policy-narrowed facet among the engine’s buckets
  - Count selected values through the same chunked multi_search as every other search
  - Leave facet-only paging to searchFacets instead of stripping it in the GraphQL loader
  - Correct the docs that promised a single multi_search request
  - Move the private ownership helpers below the module’s exports"
  M	docs/decisions/0004-search-api-graphql-surface.md
  M	docs/decisions/0005-batch-facet-queries-through-the-engine-port.md
  A	docs/decisions/0029-make-skip-own-filter-what-a-facet-means.md
  M	docs/reference/search-api-graphql.md
  M	docs/reference/search-typesense.md
  M	docs/reference/search.md
  M	packages/search-api-graphql/src/build-schema.ts
  M	packages/search-api-graphql/src/facet-batch.ts
  M	packages/search-api-graphql/test/build-schema.test.ts
  M	packages/search-api-graphql/test/facet-batch.test.ts
  M	packages/search-api-graphql/vite.config.ts
  M	packages/search-typesense/src/search.ts
  M	packages/search-typesense/test/facet-policy.test.ts
  M	packages/search-typesense/test/search-engine.test.ts
  A	packages/search-typesense/test/skip-own-filter.test.ts
  M	packages/search-typesense/vite.config.ts
  M	packages/search/src/adapter.ts
  M	packages/search/src/engine.ts
  M	packages/search/src/query.ts
  M	packages/search/src/testing.ts
  A	packages/search/test/facet-searches.test.ts
  M	packages/search/vite.config.ts

### 🧱 Updated Dependencies

- Updated @lde/search to 0.31.0

## 0.34.0 (2026-10-23)

### 🚀 Features

- ⚠️  **search:** report a range facet’s extent, over the collection and within the other filters ([#945](https://github.com/ldelements/lde/pull/945))

### ⚠️  Breaking Changes

- **search:** report a range facet’s extent, over the collection and within the other filters  ([#945](https://github.com/ldelements/lde/pull/945))
  FacetMap values are Facet objects – read facet.buckets.
  A facetable integer, number or date field no longer returns per-value buckets;
  declare facetRanges for a histogram. In GraphQL a numeric facet is an object:
  select size { buckets { min max count } } instead of size { min max count },
  and all { min max } or matching { min max } for its extent. A collection whose
  type has a facetable, non-sortable numeric field changes definition: rebuild it.
  * feat(search)!: keep a numeric facet’s per-value buckets beside its extent
  - An unbinned numeric facet buckets per distinct value again; Typesense reports
    its stats either way, so the open extent-only bin is gone
  - Add isBinnedRangeFacet for a field with bins; isRangeFacet holds for every
    numeric field
  - Index only a binned field for sorting, which Typesense needs to bin it
  - Rename the GraphQL ‹Kind›HistogramFacet to ‹Kind›BinnedRangeFacet and give
    ‹Kind›RangeFacet per-value buckets, a date’s in ISO 8601
  - Report a facet that fails in both scopes once
  BREAKING CHANGE: isRangeFacet now holds for every numeric field; use
  isBinnedRangeFacet for its old meaning. In GraphQL, ‹Kind›HistogramFacet is
  ‹Kind›BinnedRangeFacet, and a date facet’s per-value bucket value is ISO 8601."
  M	docs/reference/search-api-graphql.md
  M	docs/reference/search-typesense.md
  M	docs/reference/search.md
  M	packages/search-api-graphql/src/build-schema.ts
  M	packages/search-api-graphql/src/facet-batch.ts
  M	packages/search-api-graphql/test/build-schema.test.ts
  M	packages/search-api-graphql/test/facet-batch.test.ts
  M	packages/search-api-graphql/vite.config.ts
  M	packages/search-typesense/src/collection-definition.ts
  M	packages/search-typesense/src/query-compiler.ts
  M	packages/search-typesense/src/search.ts
  M	packages/search-typesense/test/collection-definition.test.ts
  M	packages/search-typesense/test/facet-policy.test.ts
  M	packages/search-typesense/test/label-sources.test.ts
  M	packages/search-typesense/test/parse-response.test.ts
  M	packages/search-typesense/test/polymorphic-lookup.test.ts
  M	packages/search-typesense/test/search-engine.test.ts
  M	packages/search-typesense/vite.config.ts
  M	packages/search/src/adapter.ts
  M	packages/search/src/engine.ts
  M	packages/search/src/index.ts
  M	packages/search/src/schema.ts
  M	packages/search/src/testing.ts
  M	packages/search/test/engine.test.ts
  M	packages/search/test/schema.test.ts
  M	packages/search/vite.config.ts

### 🧱 Updated Dependencies

- Updated @lde/search to 0.30.0

## 0.33.0 (2026-10-22)

### 🩹 Fixes

- ⚠️  **search-api-graphql:** treat und as untagged and leave nulled values out of Content-Language ([#929](https://github.com/ldelements/lde/pull/929))

### ⚠️  Breaking Changes

- **search-api-graphql:** treat und as untagged and leave nulled values out of Content-Language  ([#929](https://github.com/ldelements/lde/pull/929))
  SearchContext.servedLanguages is now a Map<string, string>
  keyed by response path instead of a Set<string>. A custom transport passes
  new Map() and reads its values()."
  M	docs/reference/search-api-graphql.md
  M	packages/search-api-graphql/src/build-schema.ts
  M	packages/search-api-graphql/src/handler.ts
  M	packages/search-api-graphql/src/language.ts
  M	packages/search-api-graphql/test/build-schema.test.ts
  M	packages/search-api-graphql/test/handler.test.ts
  M	packages/search-api-graphql/test/language.test.ts
  M	packages/search-api-graphql/vite.config.ts

## 0.32.0 (2026-10-22)

### 🚀 Features

- ⚠️  **search-api-graphql:** cap the root fields one operation may select ([#928](https://github.com/ldelements/lde/pull/928))

### ⚠️  Breaking Changes

- **search-api-graphql:** cap the root fields one operation may select  ([#928](https://github.com/ldelements/lde/pull/928))
  an operation selecting more than 10 root fields is now rejected.
  Raise maxSearches (MAX_SEARCHES on the server) if a client needs more."
  M	docs/reference/search-api-graphql.md
  M	docs/reference/search-api-server.md
  M	packages/search-api-graphql/src/handler.ts
  A	packages/search-api-graphql/src/max-searches.ts
  M	packages/search-api-graphql/test/handler.test.ts
  M	packages/search-api-graphql/vite.config.ts
  M	packages/search-api-server/src/config.ts
  M	packages/search-api-server/src/server.ts
  M	packages/search-api-server/test/config.test.ts

## 0.31.1 (2026-10-22)

### 🩹 Fixes

- **search-api-graphql:** name a lookup’s targets without an article ([#926](https://github.com/ldelements/lde/pull/926))

## 0.31.0 (2026-10-16)

### 🚀 Features

- ⚠️  **search:** resolve a reference across several targets ([#848](https://github.com/ldelements/lde/pull/848))

### ⚠️  Breaking Changes

- **search:** resolve a reference across several targets  ([#848](https://github.com/ldelements/lde/pull/848))
  labelSourceNameOf, labelTargetNameOf, localLookupTypeOf
  and inheritedFacetKeys are replaced by labelSourceNamesOf,
  labelTargetNamesOf, localLookupTargetsOf and inheritedFacetPolicies,
  which return lists (or a map) rather than a single value; _target is a
  reserved field name.
  * test(search): cover the polymorphic lookup where CI found it bare
  - Drop the GraphQL fixture that named one field at two referents: the
    schema now rejects that pairing, so the interface builder no longer
    re-checks it and the branch threshold is re-anchored.
  - Cover a single-target lookup skipping an id-only selection, an empty
    stored referent field, a single-valued polymorphic nesting and a
    cut descent that still declares its discriminator.
  * test(search-typesense): reach the edge with no endpoint through the local lookup
  The empty-endpoint case is read one level in, by the stored lookup,
  not by the inline entry above it – so the test states an edge without
  a creator rather than a work without edges.
  * fix(search): close review gaps in lookups over several targets
  - Rebuild an unanswered stored referent against its target’s levels, so its lookups nest
  - Ask each target’s collection only for the lookup fields that target declares
  - Reject an empty target or labelSource list with a new empty-target issue
  - Refuse a type whose filter name collides with a multi-target lookup’s, output or not
  - Read rdf:type and key hops as UNION branches of one OPTIONAL, so no row cross product
  - Stop tracking a generated coverage summary and ignore coverage directories everywhere
  - Drop a stale coverage-threshold comment and a duplicated GraphQL test
  * fix(search-api-graphql): serve an untyped referent as an unresolved reference
  - Resolve a referent no collection holds to ‹Set›UnresolvedReference, not the first target
  - Make every interface field nullable, since the unresolved type carries only its id
  - Record the choice, and why dropping the referent was rejected, in ADR 28
  * test(search-api-graphql): cover the nullable id of a local lookup over several targets"
  M	.gitignore
  A	docs/decisions/0028-resolve-a-reference-across-several-targets.md
  M	docs/reference/search-api-graphql.md
  M	docs/reference/search-pipeline.md
  M	docs/reference/search-typesense.md
  M	docs/reference/search.md
  M	packages/search-api-graphql/src/build-schema.ts
  M	packages/search-api-graphql/src/projection.ts
  A	packages/search-api-graphql/test/polymorphic-lookup.test.ts
  M	packages/search-pipeline/src/extraction.ts
  M	packages/search-pipeline/test/extraction.test.ts
  A	packages/search-pipeline/test/polymorphic-extraction.test.ts
  M	packages/search-typesense/src/collection-definition.ts
  M	packages/search-typesense/src/lookup.ts
  M	packages/search-typesense/src/query-compiler.ts
  M	packages/search-typesense/src/search.ts
  A	packages/search-typesense/test/polymorphic-lookup.test.ts
  M	packages/search-typesense/test/qualified-relation.test.ts
  M	packages/search/src/adapter.ts
  M	packages/search/src/engine.ts
  M	packages/search/src/index.ts
  M	packages/search/src/join-graph.ts
  M	packages/search/src/project.ts
  M	packages/search/src/query.ts
  M	packages/search/src/schema.ts
  M	packages/search/src/testing.ts
  A	packages/search/test/polymorphic-lookup.test.ts
  M	packages/search/test/qualified-relation.test.ts
  M	packages/search/test/schema.test.ts

### 🧱 Updated Dependencies

- Updated @lde/search to 0.29.0

## 0.30.3 (2026-10-16)

### 🩹 Fixes

- **search-api-graphql:** send Vary and Content-Language for Accept-Language ([#917](https://github.com/ldelements/lde/pull/917))

## 0.30.2 (2026-10-16)

### 🩹 Fixes

- **search:** match language tags against locales as language ranges ([#919](https://github.com/ldelements/lde/pull/919))

### 🧱 Updated Dependencies

- Updated @lde/search to 0.28.1

## 0.30.1 (2026-10-16)

### 🩹 Fixes

- **search-api-graphql:** flatten fragments in depth and cost limits ([#916](https://github.com/ldelements/lde/pull/916))

## 0.30.0 (2026-10-15)

### 🧱 Updated Dependencies

- Updated @lde/search to 0.28.0

## 0.29.2 (2026-10-14)

### 🧱 Updated Dependencies

- Updated @lde/search to 0.27.2

## 0.29.1 (2026-10-14)

### 🩹 Fixes

- **search:** keep a Reference Type entry’s IRI out of its fields ([#895](https://github.com/ldelements/lde/pull/895))

### 🧱 Updated Dependencies

- Updated @lde/search to 0.27.1

## 0.29.0 (2026-09-09)

### 🩹 Fixes

- ⚠️  **search:** let a derive read a Reference Type entry’s node IRI ([#843](https://github.com/ldelements/lde/pull/843))

### ⚠️  Breaking Changes

- **search:** let a derive read a Reference Type entry’s node IRI  ([#843](https://github.com/ldelements/lde/pull/843))
  an edge type built from a Reference Type loses its `id`
    field"
  M	docs/reference/search.md
  M	packages/search-api-graphql/src/build-schema.ts
  M	packages/search-api-graphql/test/build-schema.test.ts
  M	packages/search-api-graphql/vite.config.ts
  M	packages/search/src/project.ts
  M	packages/search/test/project.test.ts
  M	packages/search/test/qualified-relation.test.ts

### 🧱 Updated Dependencies

- Updated @lde/search to 0.27.0

## 0.28.0 (2026-09-09)

### 🧱 Updated Dependencies

- Updated @lde/search to 0.26.0

## 0.27.0 (2026-09-04)

### 🧱 Updated Dependencies

- Updated @lde/search to 0.25.0

## 0.26.4 (2026-09-04)

### 🧱 Updated Dependencies

- Updated @lde/search to 0.24.4

## 0.26.3 (2026-09-04)

### 🧱 Updated Dependencies

- Updated @lde/search to 0.24.3

## 0.26.2 (2026-08-31)

### 🧱 Updated Dependencies

- Updated @lde/search to 0.24.2

## 0.26.1 (2026-08-31)

### 🧱 Updated Dependencies

- Updated @lde/search to 0.24.1

## 0.26.0 (2026-08-31)

### 🚀 Features

- ⚠️  **search:** carry data on a reference edge ([#780](https://github.com/ldelements/lde/pull/780))

### ⚠️  Breaking Changes

- **search:** carry data on a reference edge  ([#780](https://github.com/ldelements/lde/pull/780))

### 🧱 Updated Dependencies

- Updated @lde/search to 0.24.0

## 0.25.2 (2026-08-24)

### 🧱 Updated Dependencies

- Updated @lde/search to 0.23.2

## 0.25.1 (2026-08-22)

### 🧱 Updated Dependencies

- Updated @lde/search to 0.23.1

## 0.25.0 (2026-08-20)

### 🧱 Updated Dependencies

- Updated @lde/search to 0.23.0

## 0.24.1 (2026-08-20)

### 🧱 Updated Dependencies

- Updated @lde/search to 0.22.1

## 0.24.0 (2026-08-17)

### 🚀 Features

- ⚠️  **search:** replace labelOnly with a lookup strategy naming its target ([#739](https://github.com/ldelements/lde/pull/739))

### 🩹 Fixes

- **search-api-graphql:** answer with the platform Response, not a ponyfilled one ([#744](https://github.com/ldelements/lde/pull/744))

### ⚠️  Breaking Changes

- **search:** replace labelOnly with a lookup strategy naming its target  ([#739](https://github.com/ldelements/lde/pull/739))
  strategy 'labelOnly' is now 'lookup', taking 'target'
  instead of 'labelSource' plus 'ref.typeName'.
  * test(search): cover the lookup strategy and the resolve projection
  - labelSourceNameOf across lookup, idOnly and a reference resolving none
  - labelSource rejected on a lookup; a lookup target that serves no labels
  - projection validated at this type's level: unknown and non-lookup fields
  * refactor(search)!: validate a query's projection at every level
  validateQuery and assertValidQuery take the schema, so each projection
  level is checked against the target the level above names – the guard's
  promise held a hole exactly where the newest feature is. Both production
  call sites are schema-bound already.
  BREAKING CHANGE: validateQuery and assertValidQuery take the SearchSchema
  as a third argument.
  * refactor(search-typesense): resolve label sources through labelSourceNameOf
  One reading for a lookup's target and an idOnly's labelSource, so the
  adapter never branches on strategy to find a collection. Fixtures that
  declared a typeName and a labelSource for the same type now name it
  once; the emitted collection schema is unchanged.
  * test(search-pipeline): declare lookup targets in the extraction fixtures
  The reference that resolved no labels becomes idOnly; the rest name the
  target they already declared twice.
  * feat(search-api-graphql)!: serve a lookup reference as its target's fields
  - a lookup's emitted type derives from its target and carries that root
    type's output fields, the rule inline already followed; its id is
    non-null, since a lookup resolves a document by IRI
  - a target's own references are registered in turn, so a cycle between
    two targets terminates on the memo rather than recursing
  - an output idOnly reference must name its emitted type: it is the one
    strategy that derives no name, and graphql-js failed cryptically on it
  BREAKING CHANGE: a labelOnly reference becomes a lookup naming its
  target, and is served with the target's output fields rather than a
  resolved label alone.
  * refactor(search-api-graphql)!: drop the id-plus-label reference shape
  Rebasing onto the IRI-typed filters made an idOnly reference a bare IRI,
  which leaves no reference emitting an id-plus-label object: a lookup
  carries its target's fields, an inline reference its Reference Type's.
  So labelKeyOf and the label-word agreement check go, and with them the
  missing-ref-type-name rule – an idOnly reference names no emitted type
  because it emits none.
  Fixtures that declared a labelOnly reference to a type nothing indexes
  were serving a label no engine could fill; they are bare IRIs now, or
  lookups where the target really is a root type.
  * feat(search-typesense)!: fetch a lookup's fields from its target's collection
  resolveProjection walks a query's projection level by level: the IRIs of
  each level are deduped across the whole page, grouped by the collection
  they live in and fetched in one batched multi_search with include_fields
  holding exactly what the level asked for. One round-trip per level, not
  per document, and a level that cannot be fetched degrades its references
  to bare ids rather than failing the search.
  The referents reconstruct through the same path a hit does, read through
  the target's own declaration, so a consumer cannot tell a projected
  referent from an inline one. The facet path is untouched: a bucket
  carries one label and stays on the cacheable label lookup.
  * docs(search): describe the lookup strategy and its projection
  - the strategy table, the reference prose and three examples described the
    removed labelOnly; copied today they threw
  - a section on projecting what a lookup carries, since what it fetches is
    named per query rather than declared
  - CONTEXT.md gains Target and Reference Projection, and marks labelOnly as
    a word to avoid
  - corrects a JSDoc claim that an output idOnly reference must name a type:
    it surfaces as a bare IRI, so there is no type to name
  * fix(search): require a ref typeName on an inline reference alone
  A lookup derives its emitted name from the target it already names, and an
  idOnly reference is served as a bare IRI, so neither can be nameless.
  * fix(search-api-graphql): project only the fields a target serves
  Every GraphQL client injects __typename into each selection set, and it
  was carried into the projection verbatim: the port's guard then reported
  it as an unknown field of the target and threw, failing the whole search
  for any query selecting a lookup. The projection now asks only for what
  the target declares as output.
  Two more, from the same review:
  - one lookup selected twice (two fragments spreading it) merged its
    deeper levels shallowly, so the second selection replaced the first and
    a field the client asked for was never fetched
  - a lookup declaring no target passed validation, since the type-name
    rule had been narrowed to inline alone
  * fix(search): reject a lookup declared inside a Reference Type
  A lookup resolves level by level from the hit's projection, and a nested
  document is read back with its referent – so nothing resolves a lookup
  inside one. It was accepted, emitting a type whose every field served
  null; now it fails at schema construction, naming the field."
  A	docs/decisions/0020-resolve-a-references-fields-from-the-targets-own-collection.md
  M	docs/reference/search.md
  M	packages/search-api-graphql/src/build-schema.ts
  A	packages/search-api-graphql/src/projection.ts
  M	packages/search-api-graphql/test/__snapshots__/generator-stability.test.ts.snap
  M	packages/search-api-graphql/test/build-schema.test.ts
  M	packages/search-api-graphql/test/generator-stability.test.ts
  A	packages/search-api-graphql/test/projection.test.ts
  M	packages/search-api-graphql/vite.config.ts
  M	packages/search-pipeline/test/extraction-roundtrip.integration.test.ts
  M	packages/search-pipeline/test/extraction.test.ts
  M	packages/search-pipeline/test/joins.integration.test.ts
  M	packages/search-pipeline/test/registry-extraction.integration.test.ts
  M	packages/search-pipeline/test/search-stages.test.ts
  A	packages/search-typesense/src/lookup.ts
  M	packages/search-typesense/src/search.ts
  M	packages/search-typesense/test/blue-green-rebuild.test.ts
  M	packages/search-typesense/test/collection-name.test.ts
  M	packages/search-typesense/test/generator-stability.test.ts
  M	packages/search-typesense/test/in-place-rebuild.test.ts
  M	packages/search-typesense/test/label-sources.test.ts
  M	packages/search-typesense/test/parse-response.test.ts
  A	packages/search-typesense/test/projected-lookup.test.ts
  M	packages/search-typesense/test/search-engine.test.ts
  M	packages/search-typesense/vite.config.ts
  M	packages/search/CONTEXT.md
  M	packages/search/src/adapter.ts
  M	packages/search/src/index.ts
  M	packages/search/src/join-graph.ts
  M	packages/search/src/query.ts
  M	packages/search/src/schema.ts
  M	packages/search/test/project.test.ts
  M	packages/search/test/query.test.ts
  M	packages/search/test/schema.test.ts
  M	packages/search/vite.config.ts

### 🧱 Updated Dependencies

- Updated @lde/search to 0.22.0

## 0.23.1 (2026-08-14)

### 🧱 Updated Dependencies

- Updated @lde/search to 0.21.1

## 0.23.0 (2026-08-14)

### 🩹 Fixes

- ⚠️  **search:** drop an unselectable bucket instead of failing the response ([#740](https://github.com/ldelements/lde/pull/740))

### ⚠️  Breaking Changes

- **search:** drop an unselectable bucket instead of failing the response  ([#740](https://github.com/ldelements/lde/pull/740))
  a reference facet’s bucket type is `IRIBucket`, not
  `IriBucket`. Renaming it needs a second breaking release because 0.21.0
  published the inconsistent spelling; the three names for one concept
  (`IRI`, `IRIFilter`, `IRIBucket`) are worth more on a surface ADR 4
  freezes than the cost of correcting it now, which only grows."
  M	docs/decisions/0004-search-api-graphql-surface.md
  M	docs/decisions/0019-type-a-filter-by-what-its-field-keys-on.md
  M	docs/reference/search-api-graphql.md
  M	docs/reference/search.md
  M	packages/search-api-graphql/src/build-schema.ts
  M	packages/search-api-graphql/test/__snapshots__/generator-stability.test.ts.snap
  M	packages/search-api-graphql/test/build-schema.test.ts
  M	packages/search-api-graphql/vite.config.ts
  M	packages/search/src/project.ts
  M	packages/search/src/schema.ts
  M	packages/search/test/project.test.ts
  M	packages/search/test/schema.test.ts
  M	packages/search/vite.config.ts

### 🧱 Updated Dependencies

- Updated @lde/search to 0.21.0

## 0.22.0 (2026-08-14)

### 🚀 Features

- ⚠️  **search:** filter across collections through declared joins ([#719](https://github.com/ldelements/lde/pull/719))

### ⚠️  Breaking Changes

- **search:** filter across collections through declared joins  ([#719](https://github.com/ldelements/lde/pull/719))
  the Typesense rebuild and collection-definition options
  take `collectionNameFor: (searchType) => string` instead of `name: string`.
  Pass `collectionNameFor: () => 'x'` where a single name was passed before.
  * fix(search): close four gaps the review found in the join implementation
  - never abort a member of a partly-committed join component: the half-built
    collection it would drop is what the member that DID commit references by
    concrete name, so dropping it broke every join through the live index
    permanently. An orphaned collection is the lesser evil
  - reject `joinable` on an inline reference: the collection definition emitted
    the nesting and silently dropped the reference, so the join validated,
    compiled and only then failed at the engine
  - reject a `collectionNameFor` that gives a join target this type's own
    collection – the trap in migrating a constant from the old `name` option,
    which made the reference point the collection at itself
  - name the empty joined `where` inside an `or` on its own terms; it crashed on
    the missing clause instead of reporting anything
  * fix(pipeline): let a coordinating caller end a run without discarding its output
  - add the optional `RunWriter.abandon(error)`: finalize and release run-level
    resources, keep what was built. It falls back to `abort`, which is already
    right for a writer whose abort discards nothing
  - implement it on the Typesense blue/green rebuild as a lock release without
    the collection drop, and use it for the uncommitted peers of a committed
    member. Skipping them instead held the rebuild lock for its whole TTL and
    failed the next run outright
  - count `joinable` as a Role, so a join-only reference is stored rather than
    pruned as an Internal Field and then joined against a column that is not there
  - tell a lookalike search type apart from a missing schema when a joinable
    reference cannot be resolved
  * fix(search-api-graphql): key a join's `in` arm on IRI like every other identity filter
  - the arm asks what `‹Target›Filter` asks – which of the target's ids the
    field holds – so it must accept the same `[IRI!]` variable a consumer
    declares. Typing it `String` left the join the one place identity was not
    IRI-keyed"
  M	AGENTS.md
  A	docs/decisions/0019-filter-across-collections-through-declared-joins.md
  M	docs/reference/pipeline.md
  M	docs/reference/search-api-graphql.md
  M	docs/reference/search-pipeline.md
  M	docs/reference/search-typesense.md
  M	docs/reference/search.md
  M	packages/pipeline/src/writer/writer.ts
  M	packages/search-api-graphql/src/build-schema.ts
  M	packages/search-api-graphql/src/facet-batch.ts
  M	packages/search-api-graphql/test/facet-batch.test.ts
  A	packages/search-api-graphql/test/joins.test.ts
  M	packages/search-api-graphql/vite.config.ts
  M	packages/search-indexer/src/composition.ts
  M	packages/search-pipeline/src/search-index-writer.ts
  A	packages/search-pipeline/test/fixtures/joins-sample.ttl
  A	packages/search-pipeline/test/joins.integration.test.ts
  M	packages/search-pipeline/test/multi-collection.integration.test.ts
  M	packages/search-pipeline/test/search-index-writer.test.ts
  M	packages/search-typesense/src/blue-green-rebuild.ts
  M	packages/search-typesense/src/collection-definition.ts
  M	packages/search-typesense/src/in-place-rebuild.ts
  M	packages/search-typesense/src/index.ts
  M	packages/search-typesense/src/lock.ts
  M	packages/search-typesense/src/query-compiler.ts
  M	packages/search-typesense/src/rebuild-support.ts
  M	packages/search-typesense/src/search.ts
  M	packages/search-typesense/test/blue-green-rebuild.test.ts
  M	packages/search-typesense/test/collection-definition.test.ts
  M	packages/search-typesense/test/collection-name.test.ts
  M	packages/search-typesense/test/generator-stability.test.ts
  M	packages/search-typesense/test/in-place-rebuild.test.ts
  A	packages/search-typesense/test/joins.test.ts
  M	packages/search-typesense/test/rebuild-error-paths.test.ts
  M	packages/search-typesense/test/rebuild-support.test.ts
  A	packages/search-typesense/test/reference-backfill.integration.test.ts
  M	packages/search-typesense/test/search-engine.test.ts
  M	packages/search-typesense/vite.config.ts
  M	packages/search/src/adapter.ts
  M	packages/search/src/index.ts
  A	packages/search/src/join-graph.ts
  M	packages/search/src/query.ts
  M	packages/search/src/schema.ts
  A	packages/search/test/join-graph.test.ts
  M	packages/search/test/query.test.ts
  M	packages/search/test/schema.test.ts
  M	packages/search/vite.config.ts

### 🧱 Updated Dependencies

- Updated @lde/search to 0.20.0

## 0.21.1 (2026-08-14)

### 🩹 Fixes

- **search-api-graphql:** tell the caller which argument they got wrong ([0c72131](https://github.com/ldelements/lde/commit/0c72131))

## 0.21.0 (2026-08-14)

### 🚀 Features

- ⚠️  **search:** type a filter by what its field keys on ([7926e44](https://github.com/ldelements/lde/commit/7926e44))

### ⚠️  Breaking Changes

- **search:** type a filter by what its field keys on  ([7926e44](https://github.com/ldelements/lde/commit/7926e44))
  StringFilter is replaced by KeywordFilter, IRIFilter and
  per-target filter inputs, and `id` is filtered per type. A variable must
  be declared [IRI!] rather than [String!] - GraphQL checks variable usage
  nominally, though the two are identical on the wire. Type.id and
  <Type>Reference.id are IRI!. A reference facet returns IriBucket rather
  than ValueBucket. A labelOnly/idOnly reference to a blank node is no
  longer indexed, and a non-IRI already in an index now fails on read
  instead of being served as an IRI.

### 🧱 Updated Dependencies

- Updated @lde/search to 0.19.0

## 0.20.3 (2026-08-14)

### 🚀 Features

- **search:** let a search type name its label field ([#729](https://github.com/ldelements/lde/pull/729))

### 🧱 Updated Dependencies

- Updated @lde/search to 0.18.3

## 0.20.2 (2026-08-12)

### 🚀 Features

- **search-api-graphql:** write the GraphQL contract of a schema module to a file ([#722](https://github.com/ldelements/lde/pull/722))

### 🧱 Updated Dependencies

- Updated @lde/search to 0.18.2

## 0.20.1 (2026-08-12)

### 🚀 Features

- **search:** let a field carry a description to the API surface ([#721](https://github.com/ldelements/lde/pull/721))

### 🧱 Updated Dependencies

- Updated @lde/search to 0.18.1

## 0.20.0 (2026-08-10)

### 🚀 Features

- ⚠️  **search-api-graphql:** serve a reference’s label as label, not name ([#718](https://github.com/ldelements/lde/pull/718))

### ⚠️  Breaking Changes

- **search-api-graphql:** serve a reference’s label as label, not name  ([#718](https://github.com/ldelements/lde/pull/718))
  a labelOnly reference serves its label as `label`.
  Clients selecting `name` on a reference type must select `label` instead."
  M	docs/decisions/0004-search-api-graphql-surface.md
  M	docs/reference/search-api-graphql.md
  M	docs/reference/search.md
  M	packages/search-api-graphql/src/build-schema.ts
  M	packages/search-api-graphql/test/__snapshots__/generator-stability.test.ts.snap
  M	packages/search-api-graphql/test/build-schema.test.ts

## 0.19.0 (2026-08-07)

### 🚀 Features

- ⚠️  **search:** filter across several fields with one where clause ([#711](https://github.com/ldelements/lde/pull/711))

### ⚠️  Breaking Changes

- **search:** filter across several fields with one where clause  ([#711](https://github.com/ldelements/lde/pull/711))
  SearchQuery.where clauses are { or: [Criterion] } rather than
  a field plus an operator; filterOn builds the single-field case. A SearchType
  declaring a field named and or or no longer validates."
  M	docs/decisions/0003-search-api-core-query-model.md
  A	docs/decisions/0018-filter-across-several-fields-with-one-clause.md
  M	docs/reference/search-api-graphql.md
  M	docs/reference/search.md
  M	packages/search-api-graphql/package.json
  M	packages/search-api-graphql/src/build-schema.ts
  M	packages/search-api-graphql/src/facet-batch.ts
  M	packages/search-api-graphql/test/__snapshots__/generator-stability.test.ts.snap
  M	packages/search-api-graphql/test/build-schema.test.ts
  M	packages/search-api-graphql/test/facet-batch.test.ts
  M	packages/search-api-graphql/vite.config.ts
  M	packages/search-typesense/src/query-compiler.ts
  M	packages/search-typesense/test/parse-response.test.ts
  M	packages/search-typesense/test/query-compiler.test.ts
  M	packages/search-typesense/test/search-engine.test.ts
  M	packages/search-typesense/vite.config.ts
  M	packages/search/src/adapter.ts
  M	packages/search/src/index.ts
  M	packages/search/src/query.ts
  M	packages/search/src/schema.ts
  M	packages/search/src/testing.ts
  M	packages/search/test/query.test.ts
  M	packages/search/test/schema.test.ts

### 🧱 Updated Dependencies

- Updated @lde/search to 0.18.0

## 0.18.0 (2026-08-07)

### 🚀 Features

- ⚠️  **search-api-graphql:** type boolean facets with a BooleanBucket ([#707](https://github.com/ldelements/lde/pull/707))

### ⚠️  Breaking Changes

- **search-api-graphql:** type boolean facets with a BooleanBucket  ([#707](https://github.com/ldelements/lde/pull/707))

### 🧱 Updated Dependencies

- Updated @lde/search to 0.17.0

## 0.17.0 (2026-08-07)

### 🧱 Updated Dependencies

- Updated @lde/search to 0.16.0

## 0.16.0 (2026-07-31)

### 🚀 Features

- ⚠️  **search:** serve a surfaced inline reference as a nested document ([#689](https://github.com/ldelements/lde/pull/689))

### ⚠️  Breaking Changes

- **search:** serve a surfaced inline reference as a nested document  ([#689](https://github.com/ldelements/lde/pull/689))

### 🧱 Updated Dependencies

- Updated @lde/search to 0.15.0

## 0.15.0 (2026-07-31)

### 🧱 Updated Dependencies

- Updated @lde/search to 0.14.0

## 0.14.0 (2026-07-30)

### 🚀 Features

- ⚠️  **search:** look documents up by their IRI on every type ([#676](https://github.com/ldelements/lde/pull/676))

### ⚠️  Breaking Changes

- **search:** look documents up by their IRI on every type  ([#676](https://github.com/ldelements/lde/pull/676))

### 🧱 Updated Dependencies

- Updated @lde/search to 0.13.0

## 0.13.0 (2026-07-28)

### 🚀 Features

- ⚠️  **search-api-graphql:** group result pagination into a shared Pagination type ([#673](https://github.com/ldelements/lde/pull/673))

### ⚠️  Breaking Changes

- **search-api-graphql:** group result pagination into a shared Pagination type  ([#673](https://github.com/ldelements/lde/pull/673))
  the result envelope fields total, page and perPage moved
  into a pagination object; select pagination { total page perPage } instead."
  M	docs/decisions/0004-search-api-graphql-surface.md
  M	docs/guide/build-a-search-api.md
  M	docs/reference/search-api-graphql.md
  M	packages/search-api-graphql/src/build-schema.ts
  M	packages/search-api-graphql/test/__snapshots__/generator-stability.test.ts.snap
  M	packages/search-api-graphql/test/build-schema.test.ts
  M	packages/search-api-graphql/test/handler.test.ts

## 0.12.3 (2026-07-27)

### 🩹 Fixes

- **search-api-graphql:** serve labelOnly references to root types ([#668](https://github.com/ldelements/lde/pull/668))

### 🧱 Updated Dependencies

- Updated @lde/search to 0.12.3

## 0.12.2 (2026-07-24)

### 🧱 Updated Dependencies

- Updated @lde/search to 0.12.2

## 0.12.1 (2026-07-23)

### 🧱 Updated Dependencies

- Updated @lde/search to 0.12.1

## 0.12.0 (2026-07-23)

### 🚀 Features

- ⚠️  **search-api-graphql:** serve the API with a framework-agnostic handler ([4aae319](https://github.com/ldelements/lde/commit/4aae319))

### ⚠️  Breaking Changes

- **search-api-graphql:** serve the API with a framework-agnostic handler  ([4aae319](https://github.com/ldelements/lde/commit/4aae319))
  @lde/search-api-graphql now requires graphql ^16 (was
  ^15.8): the graphql-armor validation plugins do not accept graphql 15,
  and mixed graphql copies fail at runtime with the realm check. printed
  SDL no longer ends with a trailing newline (graphql 16 printSchema).

## 0.11.0 (2026-07-22)

### 🧱 Updated Dependencies

- Updated @lde/search to 0.12.0

## 0.10.0 (2026-07-21)

### 🚀 Features

- ⚠️  **search:** implement inline references and class-less reference types ([#629](https://github.com/ldelements/lde/pull/629))

### ⚠️  Breaking Changes

- **search:** implement inline references and class-less reference types  ([#629](https://github.com/ldelements/lde/pull/629))
  class is now optional on SearchType (a reference type declares
  none); an inline ref.typeName is resolved and cycle-checked at searchSchema
  construction.
  * feat(search): prune internal fields recursively through surfaced inline referents
  - Prune internal (no-role) fields at every depth: a surfaced (output)
    inline reference now has its referent's internal helper fields removed
    before the writer, so the "a field without a role reaches neither the
    engine nor the API" invariant holds inside nested documents, not just
    at the root.
  - Pruning runs as one post-order pass after all projection, so a derive
    at any depth still reads a helper field before it is removed.
  - Mark ADR 11 Accepted."
  M	docs/decisions/0011-decouple-rdf-depth-from-the-api-surface.md
  M	packages/search-api-graphql/src/build-schema.ts
  M	packages/search-api-graphql/src/facet-batch.ts
  M	packages/search-api-graphql/test/build-schema.test.ts
  M	packages/search-pipeline/src/search-index-writer.ts
  M	packages/search-pipeline/src/search-stages.ts
  M	packages/search-pipeline/src/typed-search-document.ts
  M	packages/search-pipeline/test/multi-collection.integration.test.ts
  M	packages/search-pipeline/test/search-index-writer.test.ts
  M	packages/search-pipeline/test/search-stages.test.ts
  M	packages/search-typesense/src/search.ts
  M	packages/search-typesense/test/collection-name.test.ts
  M	packages/search/README.md
  M	packages/search/src/adapter.ts
  M	packages/search/src/engine.ts
  M	packages/search/src/frame-by-type.ts
  M	packages/search/src/index.ts
  M	packages/search/src/project.ts
  M	packages/search/src/schema.ts
  M	packages/search/src/testing.ts
  M	packages/search/test/frame-by-type.test.ts
  M	packages/search/test/project.test.ts
  M	packages/search/test/schema.test.ts
  M	packages/search/vite.config.ts

### 🧱 Updated Dependencies

- Updated @lde/search to 0.11.0

## 0.9.0 (2026-07-19)

### 🧱 Updated Dependencies

- Updated @lde/search to 0.10.0

## 0.8.0 (2026-07-18)

### 🚀 Features

- ⚠️  **search-pipeline:** project inside the batch, per root type (ADR 13) ([#627](https://github.com/ldelements/lde/pull/627))

### ⚠️  Breaking Changes

- **search-pipeline:** project inside the batch, per root type (ADR 13)  ([#627](https://github.com/ldelements/lde/pull/627))
  @lde/search no longer exports projectGraph or TypedSearchDocument, and
  buildSubjectIndex takes only the quad source (no rootTypes).
  * feat(search-pipeline)!: per-type projecting stages, retire the buffering writer
  Compose a search pipeline as one terminal and N per-type stages. searchStages
  builds one projecting Stage per root type: each selects its roots, extracts each
  root's quads, and projects the root-complete batch (projectRoots) into documents
  tagged with their SearchType, so memory is bounded by batchSize roots, not the
  dataset. selectByClass is a convenience selector for the object grain.
  searchIndexWriter becomes a Writer<TypedSearchDocument>: it keeps ADR 9's
  per-collection fan-out and run lifecycle but stops projecting and stops
  buffering, routing each tagged document straight to its type's engine run.
  TypedSearchDocument now lives here, the glue that needs it.
  BREAKING CHANGE: searchIndexWriter now consumes TypedSearchDocument, not Quad,
  and no longer projects; compose it with searchStages.
  * fix(search-pipeline): fail clearly when a selector omits the stage's rootVariable
  The batch project closure dereferenced binding[rootVariable].value directly, so a
  config mismatch (the stage's rootVariable differs from the selector's projected
  variable) threw an opaque TypeError. Guard the deref and throw a named error that
  points at the type and the unbound variable.
  * docs(search): fix the GraphQL indexing example and drop the tag metaphor
  The search-api-graphql README credited searchSchema with indexing (it only builds
  a schema, and the line was an unassigned no-op); clarify that the pipeline indexes
  the superset schema while the GraphQL API serves a subset. Reword the frameSubjects
  comment, which still referenced the removed rootType. Rename the document-SearchType
  relationship from tag to pair throughout (TypedSearchDocument is literally a pair);
  BCP-47 language-tag wording is left untouched."
  M	package-lock.json
  M	packages/search-api-graphql/README.md
  M	packages/search-pipeline/README.md
  M	packages/search-pipeline/package.json
  M	packages/search-pipeline/src/index.ts
  M	packages/search-pipeline/src/search-index-writer.ts
  A	packages/search-pipeline/src/search-stages.ts
  A	packages/search-pipeline/src/typed-search-document.ts
  M	packages/search-pipeline/test/multi-collection.integration.test.ts
  M	packages/search-pipeline/test/search-index-writer.test.ts
  A	packages/search-pipeline/test/search-stages.test.ts
  M	packages/search/README.md
  M	packages/search/package.json
  M	packages/search/src/engine.ts
  M	packages/search/src/frame-by-type.ts
  M	packages/search/src/index.ts
  M	packages/search/src/project.ts
  M	packages/search/test/frame-by-type.test.ts
  M	packages/search/test/project.test.ts
  M	packages/search/vite.config.ts

### 🧱 Updated Dependencies

- Updated @lde/search to 0.9.0

## 0.7.1 (2026-07-18)

### 🧱 Updated Dependencies

- Updated @lde/search to 0.8.1

## 0.7.0 (2026-07-16)

### 🧱 Updated Dependencies

- Updated @lde/search to 0.8.0

## 0.6.1 (2026-07-16)

### 🧱 Updated Dependencies

- Updated @lde/search to 0.7.1

## 0.6.0 (2026-07-15)

### 🧱 Updated Dependencies

- Updated @lde/search to 0.7.0

## 0.5.0 (2026-07-13)

### 🚀 Features

- ⚠️  **search:** rename to de-overload “schema” in the search family ([#595](https://github.com/ldelements/lde/pull/595))

### ⚠️  Breaking Changes

- **search:** rename to de-overload “schema” in the search family  ([#595](https://github.com/ldelements/lde/pull/595))
  @lde/search SearchType.type is renamed to .class, and
  @lde/search-typesense buildCollectionSchema / CollectionSchemaOptions become
  buildCollectionDefinition / CollectionDefinitionOptions. @lde/search-pipeline
  and @lde/search-api-graphql adapt internally; their own public APIs are
  unchanged."
  M	docs/decisions/0003-search-api-core-query-model.md
  M	docs/decisions/0004-search-api-graphql-surface.md
  M	docs/decisions/0008-resolve-reference-labels-from-per-reference-label-sources.md
  M	docs/decisions/0009-route-a-whole-schema-projection-to-per-type-collections.md
  M	packages/search-api-graphql/test/build-schema.test.ts
  M	packages/search-api-graphql/test/facet-batch.test.ts
  M	packages/search-api-graphql/test/generator-stability.test.ts
  M	packages/search-pipeline/README.md
  M	packages/search-pipeline/src/search-index-writer.ts
  M	packages/search-pipeline/test/multi-collection.integration.test.ts
  M	packages/search-pipeline/test/search-index-writer.test.ts
  M	packages/search-typesense/README.md
  M	packages/search-typesense/src/blue-green-rebuild.ts
  R096	packages/search-typesense/src/collection-schema.ts	packages/search-typesense/src/collection-definition.ts
  M	packages/search-typesense/src/in-place-rebuild.ts
  M	packages/search-typesense/src/index.ts
  M	packages/search-typesense/src/rebuild-support.ts
  M	packages/search-typesense/src/search.ts
  M	packages/search-typesense/test/__snapshots__/generator-stability.test.ts.snap
  M	packages/search-typesense/test/blue-green-rebuild.test.ts
  R093	packages/search-typesense/test/collection-schema.test.ts	packages/search-typesense/test/collection-definition.test.ts
  M	packages/search-typesense/test/generator-stability.test.ts
  M	packages/search-typesense/test/in-place-rebuild.test.ts
  M	packages/search-typesense/test/label-sources.test.ts
  M	packages/search-typesense/test/parse-response.test.ts
  M	packages/search-typesense/test/query-compiler.test.ts
  M	packages/search-typesense/test/rebuild-error-paths.test.ts
  M	packages/search-typesense/test/rebuild-support.test.ts
  M	packages/search-typesense/test/search-engine.test.ts
  M	packages/search/README.md
  M	packages/search/src/project.ts
  M	packages/search/src/schema.ts
  M	packages/search/src/testing.ts
  M	packages/search/test/engine.test.ts
  M	packages/search/test/project.test.ts
  M	packages/search/test/query.test.ts
  M	packages/search/test/schema.test.ts

### 🧱 Updated Dependencies

- Updated @lde/search to 0.6.0

## 0.4.0 (2026-07-10)

### 🧱 Updated Dependencies

- Updated @lde/search to 0.5.0

## 0.3.1 (2026-07-10)

### 🧱 Updated Dependencies

- Updated @lde/search to 0.4.1

## 0.3.0 (2026-07-08)

### 🧱 Updated Dependencies

- Updated @lde/search to 0.4.0

## 0.2.1 (2026-07-08)

### 🧱 Updated Dependencies

- Updated @lde/search to 0.3.1

## 0.2.0 (2026-07-06)

### 🚀 Features

- ⚠️  **search:** batch facet searches into a single multi_search ([#554](https://github.com/ldelements/lde/pull/554))

### 🩹 Fixes

- **release:** unblock the search 0.3.0 release version bumps ([#557](https://github.com/ldelements/lde/pull/557))

### ⚠️  Breaking Changes

- **search:** batch facet searches into a single multi_search  ([#554](https://github.com/ldelements/lde/pull/554))
  SearchEngine implementations must add the searchFacets method.
  * feat(search)!: report per-query outcomes from searchFacets
  - searchFacets returns one FacetsOutcome ({ facets } or { error }) per query,
    so one failed query no longer discards its siblings' facets: the surface
    degrades exactly the failed query's facets and reports each via onFacetError
  - the Typesense adapter passes a failed multi_search entry through as an
    in-place error naming the query's facet fields, and normalizes orderBy
    away alongside limit/offset (facet-only compiles carry no sort)
  - fetchLabels now throws on an inline multi_search error entry, engaging the
    label degradation path instead of silently missing every label
  - a missing outcome (port-contract breach) is reported, not read as empty
  - restore the lazy iris thunk so the cached-label path skips collecting them
  - record the decision as ADR 5 and amend the port snippet in ADR 3
  BREAKING CHANGE: searchFacets returns FacetsOutcome[] instead of FacetMap[].
  * style: use EN dashes in prose added by the facet batching
  * test(search-typesense): extract a shared fake Typesense client
  - one configurable fake (search, export, multi_search; recorded performs and
    export calls) replaces the five bespoke fakes in parse-response.test.ts
  - labelLookup() shares the filter_by id-list answering between the fetchLabels
    and bundled-label-lookup tests
  - re-anchor coverage thresholds: the helper's defensive guards are uncovered"
  M	docs/decisions/0003-search-api-core-query-model.md
  A	docs/decisions/0005-batch-facet-queries-through-the-engine-port.md
  M	package-lock.json
  M	packages/search-api-graphql/README.md
  M	packages/search-api-graphql/package.json
  M	packages/search-api-graphql/src/build-schema.ts
  A	packages/search-api-graphql/src/facet-batch.ts
  M	packages/search-api-graphql/test/build-schema.test.ts
  A	packages/search-api-graphql/test/facet-batch.test.ts
  M	packages/search-api-graphql/vite.config.ts
  M	packages/search-typesense/README.md
  M	packages/search-typesense/src/search.ts
  A	packages/search-typesense/test/fake-typesense-client.ts
  M	packages/search-typesense/test/parse-response.test.ts
  M	packages/search-typesense/test/search-engine.test.ts
  M	packages/search-typesense/vite.config.ts
  M	packages/search/README.md
  M	packages/search/src/engine.ts
  M	packages/search/src/index.ts
  M	packages/search/src/testing.ts
  M	packages/search/test/engine.test.ts

### 🧱 Updated Dependencies

- Updated @lde/search to 0.3.0

## 0.1.0 (2026-07-05)

### 🚀 Features

- ⚠️  **search:** engine- and domain-agnostic query model, Typesense adapter, and GraphQL surface ([#529](https://github.com/ldelements/lde/pull/529))

### 🩹 Fixes

- **release:** unblock the search release version bumps ([#551](https://github.com/ldelements/lde/pull/551))

### ⚠️  Breaking Changes

- **search:** engine- and domain-agnostic query model, Typesense adapter, and GraphQL surface  ([#529](https://github.com/ldelements/lde/pull/529))
  reworks the @lde/search and @lde/search-typesense public APIs; see
  the package READMEs and ADRs 0003/0004.
  Claude-Session: https://claude.ai/code/session_01PDZBfA1bj35oc7Yqn1pc2n"
  M	README.md
  M	docs/decisions/0003-search-api-core-query-model.md
  M	docs/decisions/0004-search-api-graphql-surface.md
  M	package-lock.json
  A	packages/search-api-graphql/README.md
  A	packages/search-api-graphql/eslint.config.mjs
  A	packages/search-api-graphql/package.json
  A	packages/search-api-graphql/src/build-schema.ts
  A	packages/search-api-graphql/src/index.ts
  A	packages/search-api-graphql/src/language.ts
  A	packages/search-api-graphql/test/__snapshots__/generator-stability.test.ts.snap
  A	packages/search-api-graphql/test/build-schema.test.ts
  A	packages/search-api-graphql/test/generator-stability.test.ts
  A	packages/search-api-graphql/tsconfig.json
  A	packages/search-api-graphql/tsconfig.lib.json
  A	packages/search-api-graphql/tsconfig.spec.json
  A	packages/search-api-graphql/vite.config.ts
  M	packages/search-typesense/README.md
  M	packages/search-typesense/package.json
  M	packages/search-typesense/src/adapter.ts
  A	packages/search-typesense/src/collection-schema.ts
  M	packages/search-typesense/src/index.ts
  A	packages/search-typesense/src/query-compiler.ts
  A	packages/search-typesense/src/search.ts
  A	packages/search-typesense/test/__snapshots__/generator-stability.test.ts.snap
  M	packages/search-typesense/test/adapter.test.ts
  A	packages/search-typesense/test/collection-schema.test.ts
  A	packages/search-typesense/test/generator-stability.test.ts
  A	packages/search-typesense/test/parse-response.test.ts
  A	packages/search-typesense/test/query-compiler.test.ts
  A	packages/search-typesense/test/search-engine.test.ts
  M	packages/search-typesense/tsconfig.lib.json
  M	packages/search-typesense/vite.config.ts
  M	packages/search/README.md
  M	packages/search/package.json
  A	packages/search/src/adapter.ts
  A	packages/search/src/engine.ts
  M	packages/search/src/index.ts
  M	packages/search/src/project.ts
  A	packages/search/src/query.ts
  A	packages/search/src/schema.ts
  A	packages/search/src/testing.ts
  A	packages/search/test/engine.test.ts
  M	packages/search/test/project.test.ts
  A	packages/search/test/query.test.ts
  A	packages/search/test/schema.test.ts
  M	packages/search/vite.config.ts
  M	tsconfig.json

### 🧱 Updated Dependencies

- Updated @lde/search to 0.2.0