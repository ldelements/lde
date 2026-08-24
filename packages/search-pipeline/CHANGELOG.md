## 0.24.3 (2026-08-24)

### 🧱 Updated Dependencies

- Updated @lde/search-typesense to 0.27.3
- Updated @lde/pipeline to 0.36.2
- Updated @lde/search to 0.23.2

## 0.24.2 (2026-08-22)

### 🚀 Features

- **search:** key a root type on a declared field ([#764](https://github.com/ldelements/lde/pull/764))

### 🧱 Updated Dependencies

- Updated @lde/search-typesense to 0.27.2
- Updated @lde/search to 0.23.1

## 0.24.1 (2026-08-21)

### 🧱 Updated Dependencies

- Updated @lde/search-typesense to 0.27.1
- Updated @lde/pipeline to 0.36.1

## 0.24.0 (2026-08-20)

### 🧱 Updated Dependencies

- Updated @lde/search-typesense to 0.27.0

## 0.23.0 (2026-08-20)

### 🧱 Updated Dependencies

- Updated @lde/search-typesense to 0.26.0
- Updated @lde/search to 0.23.0

## 0.22.1 (2026-08-20)

### 🧱 Updated Dependencies

- Updated @lde/search-typesense to 0.25.1
- Updated @lde/search to 0.22.1

## 0.22.0 (2026-08-17)

### 🚀 Features

- ⚠️  **search:** replace labelOnly with a lookup strategy naming its target ([#739](https://github.com/ldelements/lde/pull/739))

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

- Updated @lde/search-typesense to 0.25.0
- Updated @lde/search to 0.22.0

## 0.21.1 (2026-08-14)

### 🧱 Updated Dependencies

- Updated @lde/search-typesense to 0.24.1
- Updated @lde/search to 0.21.1

## 0.21.0 (2026-08-14)

### 🧱 Updated Dependencies

- Updated @lde/search-typesense to 0.24.0
- Updated @lde/search to 0.21.0

## 0.20.0 (2026-08-14)

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

- Updated @lde/search-typesense to 0.23.0
- Updated @lde/pipeline to 0.36.0
- Updated @lde/search to 0.20.0

## 0.19.0 (2026-08-14)

### 🧱 Updated Dependencies

- Updated @lde/search-typesense to 0.22.0
- Updated @lde/search to 0.19.0

## 0.18.4 (2026-08-14)

### 🧱 Updated Dependencies

- Updated @lde/search-typesense to 0.21.3
- Updated @lde/search to 0.18.3

## 0.18.3 (2026-08-12)

### 🧱 Updated Dependencies

- Updated @lde/search-typesense to 0.21.2
- Updated @lde/search to 0.18.2

## 0.18.2 (2026-08-12)

### 🧱 Updated Dependencies

- Updated @lde/search-typesense to 0.21.1
- Updated @lde/search to 0.18.1

## 0.18.1 (2026-08-12)

### 🚀 Features

- **search-indexer:** add a transform without forking the composition ([#720](https://github.com/ldelements/lde/pull/720))

## 0.18.0 (2026-08-07)

### 🧱 Updated Dependencies

- Updated @lde/search-typesense to 0.21.0
- Updated @lde/search to 0.18.0

## 0.17.0 (2026-08-07)

### 🧱 Updated Dependencies

- Updated @lde/search-typesense to 0.20.0
- Updated @lde/search to 0.17.0

## 0.16.0 (2026-08-07)

### 🚀 Features

- ⚠️  **search:** declare a field over the indexed dataset ([#708](https://github.com/ldelements/lde/pull/708))

### ⚠️  Breaking Changes

- **search:** declare a field over the indexed dataset  ([#708](https://github.com/ldelements/lde/pull/708))
  `staleDocumentsFilter`, `sourceDocumentsFilter`,
  `thisRunDocumentsFilter` and `membershipSweepFilters` now take the provenance
  field name as their first argument. Callers filtering on the private
  bookkeeping field pass the exported `SOURCE_FIELD`.
  * fix(search): reject a projection value carried by an inline reference
  An inline reference is stored as a nested object and carries a referent's
  projected fields; a projection value is a bare IRI with no referent. Declared
  together they passed validation, so the collection definition declared an
  object field that the projection filled with a string – and every document
  import failed. Also soften datasetField's JSDoc: it is the only such field for
  a type that reached a SearchSchema, not for a hand-built one that skipped
  validation.
  * docs(search-typesense): state what adopting a declared dataset field requires
  - InPlaceRebuild leaves an existing collection alone, so a type that gains a
    `from: 'dataset'` field keeps the old `source` column and has no field for
    the new one: the run imports, then commit fails faceting a field the
    collection does not declare. Say so, and say to rebuild the collection.
  - Note that the writer's stamp reasserts the sweep's column only, never the
    folded search companion a searchable declared field also fans out to –
    folding is the projection's convention, and restating it in the writer would
    put it in two places."
  M	docs/reference/search-typesense.md
  M	docs/reference/search.md
  M	packages/search-pipeline/src/search-stages.ts
  M	packages/search-pipeline/test/search-stages.test.ts
  M	packages/search-typesense/src/blue-green-rebuild.ts
  M	packages/search-typesense/src/in-place-rebuild.ts
  M	packages/search-typesense/src/rebuild-support.ts
  M	packages/search-typesense/src/sweep.ts
  M	packages/search-typesense/test/blue-green-rebuild.test.ts
  M	packages/search-typesense/test/in-place-rebuild.test.ts
  M	packages/search-typesense/test/rebuild-support.test.ts
  M	packages/search-typesense/test/sweep.test.ts
  M	packages/search-typesense/vite.config.ts
  M	packages/search/CONTEXT.md
  M	packages/search/src/adapter.ts
  M	packages/search/src/index.ts
  M	packages/search/src/project.ts
  M	packages/search/src/schema.ts
  M	packages/search/test/project.test.ts
  M	packages/search/test/schema.test.ts
  M	packages/search/vite.config.ts

### 🧱 Updated Dependencies

- Updated @lde/search-typesense to 0.19.0
- Updated @lde/search to 0.16.0

## 0.15.2 (2026-08-07)

### 🧱 Updated Dependencies

- Updated @lde/search-typesense to 0.18.2
- Updated @lde/pipeline to 0.35.6

## 0.15.1 (2026-08-07)

### 🚀 Features

- **search-pipeline:** extract root types from the dataset registry ([#698](https://github.com/ldelements/lde/pull/698))

### 🧱 Updated Dependencies

- Updated @lde/search-typesense to 0.18.1
- Updated @lde/pipeline to 0.35.5

## 0.15.0 (2026-07-31)

### 🚀 Features

- ⚠️  **search:** serve a surfaced inline reference as a nested document ([#689](https://github.com/ldelements/lde/pull/689))

### ⚠️  Breaking Changes

- **search:** serve a surfaced inline reference as a nested document  ([#689](https://github.com/ldelements/lde/pull/689))

### 🧱 Updated Dependencies

- Updated @lde/search-typesense to 0.18.0
- Updated @lde/search to 0.15.0

## 0.14.0 (2026-07-31)

### 🧱 Updated Dependencies

- Updated @lde/search-typesense to 0.17.0
- Updated @lde/search to 0.14.0

## 0.13.0 (2026-07-30)

### 🧱 Updated Dependencies

- Updated @lde/search-typesense to 0.16.0
- Updated @lde/search to 0.13.0

## 0.12.6 (2026-07-27)

### 🧱 Updated Dependencies

- Updated @lde/search-typesense to 0.15.6
- Updated @lde/search to 0.12.3

## 0.12.5 (2026-07-25)

### 🧱 Updated Dependencies

- Updated @lde/search-typesense to 0.15.5
- Updated @lde/pipeline to 0.35.4

## 0.12.4 (2026-07-24)

### 🧱 Updated Dependencies

- Updated @lde/local-sparql-endpoint to 0.2.15
- Updated @lde/search-typesense to 0.15.4
- Updated @lde/pipeline to 0.35.3
- Updated @lde/dataset to 0.7.9
- Updated @lde/search to 0.12.2

## 0.12.3 (2026-07-24)

### 🧱 Updated Dependencies

- Updated @lde/search-typesense to 0.15.3
- Updated @lde/pipeline to 0.35.2

## 0.12.2 (2026-07-24)

### 🚀 Features

- **search-pipeline:** add searchIndexerPipeline convenience ([#647](https://github.com/ldelements/lde/pull/647))

### 🧱 Updated Dependencies

- Updated @lde/search-typesense to 0.15.2
- Updated @lde/pipeline to 0.35.1

## 0.12.1 (2026-07-23)

### 🩹 Fixes

- **search-pipeline:** exclude blank-node subjects from selectByClass ([ee2ca3c](https://github.com/ldelements/lde/commit/ee2ca3c))

### 🧱 Updated Dependencies

- Updated @lde/search-typesense to 0.15.1
- Updated @lde/search to 0.12.1

## 0.12.0 (2026-07-23)

### 🧱 Updated Dependencies

- Updated @lde/search-typesense to 0.15.0
- Updated @lde/pipeline to 0.35.0

## 0.11.2 (2026-07-23)

### 🧱 Updated Dependencies

- Updated @lde/search-typesense to 0.14.2
- Updated @lde/pipeline to 0.34.4

## 0.11.1 (2026-07-23)

### 🧱 Updated Dependencies

- Updated @lde/search-typesense to 0.14.1
- Updated @lde/pipeline to 0.34.3

## 0.11.0 (2026-07-22)

### 🚀 Features

- ⚠️  **search:** generate extraction CONSTRUCTs from the search schema ([#630](https://github.com/ldelements/lde/pull/630))

### ⚠️  Breaking Changes

- **search:** generate extraction CONSTRUCTs from the search schema  ([#630](https://github.com/ldelements/lde/pull/630))
  the projection now reads each value under its field’s IR
  alias, not its source path; a reader must emit values under irAlias(type,
  field). path no longer keys the framed node.
  * feat(search-pipeline)!: generate extraction CONSTRUCTs from the search schema
  - Add extractionQuery / extractionQueryString: a pure SearchType →
    QueryConstruct generator (Traqula AstFactory) that mints one IR-Alias
    template triple per path-bearing field, a UNION branch per field reading its
    source path as a SPARQL property path, a free subject for the pipeline’s
    VALUES injection, and a nested template for inline references (recursing to
    the schema’s declared depth).
  - Default a stage’s reader to this generated Extraction CONSTRUCT: readers on
    SearchStageType is now optional, so a SPARQL deployment need not hand-write
    the query, and reader and projection agree by construction on the alias set.
  - Add a schema↔CONSTRUCT contract test (the minted alias set equals the field
    set the projection reads) and an end-to-end round-trip against a local SPARQL
    endpoint (generate → read → frame → project).
  - Drop the stale sparqljs entry from AGENTS.md Key Dependencies and register
    the round-trip endpoint port.
  BREAKING CHANGE: SearchStageType.readers is now optional and defaults to the
  generated Extraction CONSTRUCT; a stage relying on the default must declare its
  fields’ source paths in SPARQL property-path grammar.
  * docs(search-pipeline): explain extraction queries are well-formed for non-deduplicating engines
  - Document that the generated extraction CONSTRUCTs (UNION-per-field, given
    roots, single-subject template, no projected-away constant triple) emit one
    triple per genuine solution on a non-deduplicating engine such as QLever, so
    there is no multiplicative CONSTRUCT inflation.
  - Note that this removes the need for a client-side post-processing dedup pass,
    which would defeat the batch-bounded streaming memory model; the residual
    linear duplication from duplicate input roots is absorbed by the streaming
    per-quad subject index as a cheap backstop."
  M	AGENTS.md
  M	packages/search-pipeline/README.md
  M	packages/search-pipeline/package.json
  A	packages/search-pipeline/src/extraction.ts
  M	packages/search-pipeline/src/index.ts
  M	packages/search-pipeline/src/search-stages.ts
  A	packages/search-pipeline/test/extraction-roundtrip.integration.test.ts
  A	packages/search-pipeline/test/extraction.test.ts
  A	packages/search-pipeline/test/fixtures/drapo-sample.ttl
  M	packages/search-pipeline/test/multi-collection.integration.test.ts
  M	packages/search-pipeline/test/search-stages.test.ts
  M	packages/search-pipeline/tsconfig.lib.json
  M	packages/search/src/adapter.ts
  M	packages/search/src/project.ts
  M	packages/search/src/schema.ts
  M	packages/search/test/project.test.ts
  M	packages/search/test/schema.test.ts

### 🧱 Updated Dependencies

- Updated @lde/search-typesense to 0.14.0
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

- Updated @lde/search-typesense to 0.13.0
- Updated @lde/search to 0.11.0

## 0.9.0 (2026-07-19)

### 🚀 Features

- ⚠️  **search:** make path the whole statement of what projection reads ([#628](https://github.com/ldelements/lde/pull/628))

### ⚠️  Breaking Changes

- **search:** make path the whole statement of what projection reads  ([#628](https://github.com/ldelements/lde/pull/628))

### 🧱 Updated Dependencies

- Updated @lde/search-typesense to 0.12.0
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

- Updated @lde/search-typesense to 0.11.0
- Updated @lde/search to 0.9.0

## 0.7.2 (2026-07-18)

### 🧱 Updated Dependencies

- Updated @lde/search-typesense to 0.10.2
- Updated @lde/search to 0.8.1

## 0.7.1 (2026-07-17)

### 🧱 Updated Dependencies

- Updated @lde/search-typesense to 0.10.1
- Updated @lde/pipeline to 0.34.2

## 0.7.0 (2026-07-16)

### 🧱 Updated Dependencies

- Updated @lde/search-typesense to 0.10.0
- Updated @lde/search to 0.8.0

## 0.6.1 (2026-07-16)

### 🚀 Features

- **search-typesense:** derive collection names from the search type ([#604](https://github.com/ldelements/lde/pull/604))

### 🧱 Updated Dependencies

- Updated @lde/search-typesense to 0.9.1
- Updated @lde/search to 0.7.1

## 0.6.0 (2026-07-15)

### 🧱 Updated Dependencies

- Updated @lde/search-typesense to 0.9.0
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

- Updated @lde/search-typesense to 0.8.0
- Updated @lde/search to 0.6.0

## 0.4.1 (2026-07-12)

### 🧱 Updated Dependencies

- Updated @lde/search-typesense to 0.7.1
- Updated @lde/pipeline to 0.34.1

## 0.4.0 (2026-07-10)

### 🚀 Features

- ⚠️  **search:** route a whole-schema projection to per-type collections ([#592](https://github.com/ldelements/lde/pull/592))

### ⚠️  Breaking Changes

- **search:** route a whole-schema projection to per-type collections  ([#592](https://github.com/ldelements/lde/pull/592))
  projectGraph yields TypedSearchDocument, not SearchDocument. Read
  .document for the projected document.
  * feat(search-pipeline)!: route a whole-schema projection to per-type collections
  searchIndexWriter now fans one mixed projection stream out to the engine writer for
  each root type's collection, instead of streaming to a single writer. It takes a
  writerFor(searchType) factory, opens one engine run per type, and dispatches each
  projected document to the run for its type. A single-collection deployment is the N=1
  case; the pipeline never branches on the multi-collection shape.
  Each type is an independent blue/green rebuild (own collection, alias, lock), so the
  collections commit, sweep and fail in isolation: an empty projection for one type
  touches only its own collection; commit finalizes every collection independently and
  throws an AggregateError if any fails, so a label-collection failure never blocks the
  datasets index going live; abort finalizes only the collections that did not already
  go live (aborting a committed rebuild would drop its now-live collection).
  - add a Typesense-container integration test for independent swaps, one-type failure
    isolation, empty projection and abort cleanup
  - add ADR 9; update the READMEs
  BREAKING CHANGE: searchIndexWriter takes writerFor(searchType) instead of a single
  writer option.
  * fix(search-typesense): make BlueGreenRebuild.commit atomic at the alias swap
  The alias swap is the commit point: once it lands the new collection is live.
  The lock release that followed was unguarded, so a transient failure there
  rejected commit AFTER the swap. A caller that aborts on a rejected commit (the
  pipeline does) would then drop the collection the alias now points at, leaving
  the index pointed at a deleted collection.
  - swallow a post-swap lock-release failure (the lock is reclaimed on its TTL),
    matching the already-guarded superseded-collection delete
  - regression test: commit stays resolved when releasing the lock fails"
  M	README.md
  A	docs/decisions/0009-route-a-whole-schema-projection-to-per-type-collections.md
  M	package-lock.json
  M	packages/search-pipeline/README.md
  M	packages/search-pipeline/package.json
  M	packages/search-pipeline/src/search-index-writer.ts
  A	packages/search-pipeline/test/multi-collection.integration.test.ts
  M	packages/search-pipeline/test/search-index-writer.test.ts
  A	packages/search-pipeline/test/typesense-container.ts
  M	packages/search-pipeline/tsconfig.lib.json
  M	packages/search-pipeline/tsconfig.spec.json
  M	packages/search-typesense/src/blue-green-rebuild.ts
  M	packages/search-typesense/test/rebuild-error-paths.test.ts
  M	packages/search-typesense/vite.config.ts
  M	packages/search/README.md
  M	packages/search/src/index.ts
  M	packages/search/src/project.ts
  M	packages/search/test/project.test.ts

### 🧱 Updated Dependencies

- Updated @lde/search-typesense to 0.7.0
- Updated @lde/search to 0.5.0

## 0.3.1 (2026-07-10)

### 🧱 Updated Dependencies

- Updated @lde/search to 0.4.1

## 0.3.0 (2026-07-09)

### 🧱 Updated Dependencies

- Updated @lde/pipeline to 0.34.0

## 0.2.0 (2026-07-08)

### 🧱 Updated Dependencies

- Updated @lde/search to 0.4.0

## 0.1.2 (2026-07-08)

### 🧱 Updated Dependencies

- Updated @lde/pipeline to 0.33.4

## 0.1.1 (2026-07-08)

### 🚀 Features

- **search-pipeline:** compose search indexing as a pipeline instance ([#565](https://github.com/ldelements/lde/pull/565))

### 🧱 Updated Dependencies

- Updated @lde/pipeline to 0.33.3
- Updated @lde/search to 0.3.1