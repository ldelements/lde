## 0.11.0 (2026-07-18)

### 🧱 Updated Dependencies

- Updated @lde/search to 0.9.0

## 0.10.2 (2026-07-18)

### 🧱 Updated Dependencies

- Updated @lde/search to 0.8.1

## 0.10.1 (2026-07-17)

### 🧱 Updated Dependencies

- Updated @lde/pipeline to 0.34.2

## 0.10.0 (2026-07-16)

### 🚀 Features

- ⚠️  **search:** refuse to name a search type whose name cannot be spelled ([#605](https://github.com/ldelements/lde/pull/605))

### ⚠️  Breaking Changes

- **search:** refuse to name a search type whose name cannot be spelled  ([#605](https://github.com/ldelements/lde/pull/605))
  physicalNameTokens throws for a name it cannot spell, and for
  one leaving no word to name a container after, where it previously returned
  mangled tokens or an empty array. Adapters keep only their own engine's
  legality rules - the Typesense adapter still rules on the formatted result.
  - Drop the now-redundant top-level name from ResolvedRebuildOptions (internal),
    leaving definitionOptions.name as the one place the resolved name lives.
  - Fix the unclosed Blue/green Rebuild link in the search-typesense README."
  M	packages/search-typesense/README.md
  M	packages/search-typesense/src/blue-green-rebuild.ts
  M	packages/search-typesense/src/collection-name.ts
  M	packages/search-typesense/src/in-place-rebuild.ts
  M	packages/search-typesense/src/rebuild-support.ts
  M	packages/search-typesense/test/collection-name.test.ts
  M	packages/search-typesense/test/rebuild-support.test.ts
  M	packages/search-typesense/vite.config.ts
  M	packages/search/src/physical-name.ts
  M	packages/search/test/physical-name.test.ts
  M	packages/search/vite.config.ts

### 🧱 Updated Dependencies

- Updated @lde/search to 0.8.0

## 0.9.1 (2026-07-16)

### 🚀 Features

- **search-typesense:** derive collection names from the search type ([#604](https://github.com/ldelements/lde/pull/604))

### 🧱 Updated Dependencies

- Updated @lde/search to 0.7.1

## 0.9.0 (2026-07-15)

### 🚀 Features

- ⚠️  **search:** preserve all languages in text display ([#601](https://github.com/ldelements/lde/pull/601))

### ⚠️  Breaking Changes

- **search:** preserve all languages in text display  ([#601](https://github.com/ldelements/lde/pull/601))
  PhysicalFields no longer carries the enumerated display array;
  use displayFieldName/displayFieldPattern/displayLangOf. Label collections must
  be rebuilt to gain the regex display field.
  * fix(search): harden language-tag and field-name handling
  - Normalise an underscore-style language tag (pt_BR -> pt-BR) at projection, so
    a non-BCP-47 tag round-trips through the regex display field instead of being
    silently dropped on read.
  - Validate field names as metacharacter-free identifiers (the name is
    interpolated into the display RE2 pattern) and text locales as BCP-47-shaped
    (no underscore, the reserved name-locale separator).
  - Collapse the display projection to a single pass, and add a round-trip test
    binding displayFieldName/displayFieldPattern/displayLangOf so the convention
    cannot silently drift."
  A	docs/decisions/0010-preserve-all-languages-in-text-display.md
  M	packages/search-typesense/README.md
  M	packages/search-typesense/src/collection-definition.ts
  M	packages/search-typesense/src/search.ts
  M	packages/search-typesense/test/__snapshots__/generator-stability.test.ts.snap
  M	packages/search-typesense/test/collection-definition.test.ts
  M	packages/search-typesense/test/label-sources.test.ts
  M	packages/search-typesense/test/parse-response.test.ts
  M	packages/search-typesense/test/search-engine.test.ts
  M	packages/search-typesense/vite.config.ts
  M	packages/search/README.md
  M	packages/search/src/adapter.ts
  M	packages/search/src/project.ts
  M	packages/search/src/schema.ts
  M	packages/search/test/project.test.ts
  M	packages/search/test/schema.test.ts
  M	packages/search/vite.config.ts

### 🧱 Updated Dependencies

- Updated @lde/search to 0.7.0

## 0.8.0 (2026-07-13)

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

## 0.7.1 (2026-07-12)

### 🧱 Updated Dependencies

- Updated @lde/pipeline to 0.34.1

## 0.7.0 (2026-07-10)

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

- Updated @lde/search to 0.5.0

## 0.6.1 (2026-07-10)

### 🧱 Updated Dependencies

- Updated @lde/search to 0.4.1

## 0.6.0 (2026-07-09)

### 🧱 Updated Dependencies

- Updated @lde/pipeline to 0.34.0

## 0.5.0 (2026-07-08)

### 🚀 Features

- ⚠️  **search:** per-reference label sources ([#566](https://github.com/ldelements/lde/pull/566), [#568](https://github.com/ldelements/lde/issues/568))

### ⚠️  Breaking Changes

- **search:** per-reference label sources  ([#566](https://github.com/ldelements/lde/pull/566), [#568](https://github.com/ldelements/lde/issues/568))
  TypesenseSearchEngineOptions.labelsCollection is
  removed. Declare each label source as a SearchType (with an output,
  searchable text field ‘label’), add its collection to
  options.collections, set labelSource on each reference field, and
  rebuild label collections via buildCollectionSchema so the physical
  label fields exist. fetchLabels now takes label-lookup groups instead
  of (collection, iris).
  * refactor(search): single-source the label-field convention
  Review cleanups on the label sources:
  - labelFieldOf (exported via @lde/search/adapter) is the one place that
    knows what makes a type a label source; the schema validation and the
    Typesense engine both consult it instead of re-deriving the ‘label’
    convention per package.
  - labelValue reuses the existing localizedValue reconstruction and reads
    the untagged fallback from the label field’s own name instead of a
    literal.
  - The engine precomputes each type’s distinct label-source collections
    at construction and reuses the merged cached label map until any
    constituent collection reloads, instead of re-deduplicating and
    re-merging the full maps on every search.
  * fix(search): reject a labelSource declared on a non-reference field
  assertResolvableLabelSources validated labelSource only on reference fields, so
  a labelSource on a keyword or text field – reachable from a generated or
  hand-written schema, the untyped path this validator guards – passed searchSchema
  silently and then resolved nothing. Throw at startup so the misconfiguration
  fails fast instead of surfacing as unlabelled buckets in production.
  * fix(search-typesense): query all label locales and keep empty labels id-only
  Two per-reference label-resolution fixes found in review:
  - LabelSource.queryBy used only the first locale’s folded search field
    (physicalFields(labelField).search[0]); join all per-locale search fields so a
    label search matches every locale, not just the first.
  - a label document with no usable locale column and no bare label produced
    label: {}, which referenceValue treats as a present label; labelValue now
    returns undefined and the write skips it, so the reference stays id-only.
  * fix(search-typesense): isolate label-source failures and honor id-only references
  From the #566 review:
  - a single label collection erroring inline (e.g. mid-rebuild) made fetchLabels
    throw, blanking every reference on the page to id-only; report the failed
    source via onLabelError and skip only its entry, so healthy sources still
    resolve.
  - a reference or facet with no labelSource could still gain a label in cached
    mode, where the whole collection is preloaded into the shared map; skip the
    lookup for id-only fields and facets so they stay id-only by declaration.
  * perf(search-typesense): precompute label-lookup sources, skip non-source facets
  From the #566 review: labelLookupGroups re-derived the output reference fields
  and re-resolved their label sources on every search/searchFacets call, and
  probed `sources` per facet bucket. Precompute the { field, source } pairs once
  at construction, and skip a non-source facet in one check instead of per bucket.
  Behaviour-preserving; adds a facet test covering an id-only reference facet.
  * docs(search): renumber the label-sources ADR to 0008
  ADR 0007 is now taken by 0007-merge-namespace-alias-partitions on main (#568),
  so renumber the per-reference-label-sources ADR from 0007 to 0008 to avoid the
  collision when this branch merges.
  * docs(search): mark the label-sources ADR (0008) Accepted"
  M	docs/decisions/0005-batch-facet-queries-through-the-engine-port.md
  A	docs/decisions/0008-resolve-reference-labels-from-per-reference-label-sources.md
  M	packages/search-typesense/README.md
  M	packages/search-typesense/src/search.ts
  M	packages/search-typesense/test/fake-typesense-client.ts
  A	packages/search-typesense/test/label-sources.test.ts
  M	packages/search-typesense/test/parse-response.test.ts
  M	packages/search-typesense/test/search-engine.test.ts
  M	packages/search-typesense/vite.config.ts
  M	packages/search/README.md
  M	packages/search/src/adapter.ts
  M	packages/search/src/engine.ts
  M	packages/search/src/schema.ts
  M	packages/search/test/schema.test.ts
  M	packages/search/vite.config.ts

### 🧱 Updated Dependencies

- Updated @lde/search to 0.4.0

## 0.4.4 (2026-07-08)

### 🧱 Updated Dependencies

- Updated @lde/pipeline to 0.33.4

## 0.4.3 (2026-07-08)

### 🧱 Updated Dependencies

- Updated @lde/pipeline to 0.33.3
- Updated @lde/search to 0.3.1

## 0.4.2 (2026-07-08)

### 🧱 Updated Dependencies

- Updated @lde/pipeline to 0.33.2

## 0.4.1 (2026-07-08)

### 🧱 Updated Dependencies

- Updated @lde/pipeline to 0.33.1

## 0.4.0 (2026-07-08)

### 🚀 Features

- ⚠️  **search-typesense:** BlueGreenRebuild and InPlaceRebuild writers ([#560](https://github.com/ldelements/lde/pull/560))

### ⚠️  Breaking Changes

- **search-typesense:** BlueGreenRebuild and InPlaceRebuild writers  ([#560](https://github.com/ldelements/lde/pull/560))
  RunWriter.flush takes a second DatasetOutcome argument.
  Implementations that ignore it are unaffected; direct callers pass one.
  * feat(search-typesense)!: replace rebuild() with transactional writers
  The one-shot rebuild() becomes two @lde/pipeline Writer implementations,
  one per update mode, so a Pipeline drives indexing without branching on
  the mode (see docs/decisions/0006):
  - BlueGreenRebuild: openRun takes the single-flight cross-pod lock and
    creates a fresh versioned collection; write streams documents into it,
    batched across write calls; commit atomically repoints the alias,
    drops the superseded collection and releases the lock; abort drops the
    half-built collection. Deletion is implicit.
  - InPlaceRebuild (new): per-source upsert into one long-lived collection,
    each document stamped with source and last_seen. A successful dataset
    flush sweeps the source’s documents the run did not rewrite (a failed
    dataset is not swept – the next successful run reconciles); commit
    sweeps sources that left the run’s selection and releases the lock;
    abort only releases the lock.
  The pure sweep planning (departed sources, stale/source filters) is
  exported for reuse; the membership sweep throws beyond the 10 000-source
  facet cap rather than sweeping blind. A run opened while another holds
  the lock throws RebuildAlreadyRunning instead of returning null.
  BREAKING CHANGE: rebuild() and RebuildOptions are gone; construct a
  BlueGreenRebuild (options unchanged) and drive it via openRun →
  write → commit, or let an @lde/pipeline Pipeline do so. @lde/pipeline
  and @lde/dataset are now peerDependencies.
  * refactor(search-typesense): deduplicate the rebuild writers’ plumbing
  Review cleanups on the rebuild writers:
  - The lock choreography lives once: openLockedRun acquires the
    single-flight lock, runs the writer-specific setup, and releases the
    lock again when the setup fails – both writers now contain only their
    genuinely different bodies. The shared import batch default moves next
    to BatchImporter.
  - acquireLock takes the lock in a single request on the happy path,
    creating the lock collection only on the first-ever 404, via a shared
    ensureCollectionExists that both the lock and the In-place collection
    use (giving the latter concurrent-creator tolerance for free).
  - sweep.ts owns the source/last_seen bookkeeping names, so stamping and
    sweeping can never disagree, and quotes filter values with the
    query compiler’s escapeFilterValue instead of a second quoting policy
    that threw on backticks.
  - The membership sweep deletes departed sources in combined, length-
    budgeted filters (membershipSweepFilters) instead of one round-trip
    per source.
  - The rebuild specs share one test/helpers.ts (run contexts, document
    streams, Typesense errors, lock seeding) instead of four copies.
  * build(search-typesense): align peer range and lockfile with the release
  main released @lde/pipeline 0.32.0 (and rewrote dependent peer ranges)
  after this branch declared its ^0.31.4 peer, so npm ci failed with
  ERESOLVE. The peer range now tracks the released major-equivalent and
  the lockfile is regenerated from main’s.
  * docs(search-typesense): gloss the Blue/green and In-place rebuild patterns
  Keep the shared ubiquitous language (the NDE Stack pattern names, matched
  1:1 in code and docs) but expand each term inline the first time it
  appears, so a reader without deployment background gets the mechanism
  without a rename: Blue/green = build fresh then swap atomically, In-place
  = update the live index directly. Links to the Stack patterns page.
  * fix(search-typesense): correct the membership-sweep source-cap boundary
  The cap check requested max_facet_values equal to the ceiling and threw
  on counts.length >= ceiling, so exactly N distinct sources (Typesense
  returns at most max_facet_values) tripped a false truncation error, and
  an index that genuinely grew past the ceiling threw on every commit –
  the sweep never ran, the source count never dropped, and the index
  wedged permanently.
  Now request ceiling + 1 and throw only on > ceiling, so a full-but-not-
  truncated facet proceeds and only a real overflow refuses. The ceiling
  is exposed as InPlaceRebuildOptions.maxSweepableSources (default 10 000)
  so an operator can raise it ahead of the wall instead of redeploying.
  * fix(pipeline): roll back opened writers when a fan-out sibling’s openRun fails
  FanOutWriter.openRun awaited all writers with Promise.all and the
  pipeline opens the run outside its try, so if one writer opened (taking
  a cross-pod lock, creating a collection) and a sibling’s openRun then
  rejected, the pipeline threw before it had a run to abort – leaking the
  opened writer’s lock and collection. openRun now settles all writers,
  aborts the ones that opened, and rethrows the first failure.
  * fix(search-typesense): roll back a failed dataset from both rebuild writers
  The rebuild writers implemented no reset and Blue/green consulted no
  per-dataset outcome, so the pipeline's dump-fallback discard was a
  no-op and a dataset that failed after streaming documents left them in
  the index: Blue/green shipped them at the swap, In-place kept them
  stamped with the current runId where the success sweep could not reach.
  Both writers now stamp each document with its source (dataset IRI) and
  roll a dataset out on reset / a failed flush, streaming — no buffering,
  so it scales to object volumes:
  - Blue/green deletes the dataset's documents from the not-yet-live
    collection (source = dataset); a failed dataset contributes nothing to
    the swap.
  - In-place deletes only this run's writes for the source
    (source = dataset && last_seen = runId) on reset, leaving prior-run
    documents for the success sweep to reconcile; a failed flush still
    leaves them for the next run.
  The shared bookkeeping (SOURCE_FIELD stamping, deleteByFilter, options
  resolution, reserved-field guard) moves to rebuild-support.ts so both
  writers single-source it.
  * test(pipeline): lower coverage floor for the fan-out openRun rollback branch"
  M	docs/decisions/0006-make-the-writer-transaction-aware.md
  M	package-lock.json
  M	packages/pipeline-shacl-validator/src/shacl-validator.ts
  M	packages/pipeline-shacl-validator/test/shacl-validator.test.ts
  M	packages/pipeline/README.md
  M	packages/pipeline/src/pipeline.ts
  M	packages/pipeline/src/writer/fileWriter.ts
  M	packages/pipeline/src/writer/writer.ts
  M	packages/pipeline/test/pipeline.test.ts
  M	packages/pipeline/vite.config.ts
  M	packages/search-typesense/README.md
  M	packages/search-typesense/package.json
  D	packages/search-typesense/src/adapter.ts
  A	packages/search-typesense/src/blue-green-rebuild.ts
  A	packages/search-typesense/src/import.ts
  A	packages/search-typesense/src/in-place-rebuild.ts
  M	packages/search-typesense/src/index.ts
  A	packages/search-typesense/src/lock.ts
  A	packages/search-typesense/src/rebuild-support.ts
  A	packages/search-typesense/src/sweep.ts
  D	packages/search-typesense/test/adapter.test.ts
  A	packages/search-typesense/test/blue-green-rebuild.test.ts
  A	packages/search-typesense/test/helpers.ts
  A	packages/search-typesense/test/in-place-rebuild.test.ts
  A	packages/search-typesense/test/lock.test.ts
  A	packages/search-typesense/test/rebuild-error-paths.test.ts
  A	packages/search-typesense/test/rebuild-support.test.ts
  A	packages/search-typesense/test/sweep.test.ts
  M	packages/search-typesense/tsconfig.lib.json
  M	packages/search-typesense/vite.config.ts

### 🧱 Updated Dependencies

- Updated @lde/pipeline to 0.33.0

## 0.3.0 (2026-07-06)

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

## 0.2.0 (2026-07-05)

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

## 0.1.1 (2026-06-26)

This was a version bump only for @lde/search-typesense to align it with other projects, there were no code changes.

## 0.1.0 (2026-06-18)

### 🚀 Features

- add @lde/search-typesense and @lde/text-normalization ([#475](https://github.com/ldelements/lde/pull/475), [#252](https://github.com/ldelements/lde/issues/252))