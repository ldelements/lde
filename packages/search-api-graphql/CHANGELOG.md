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