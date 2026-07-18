# @lde/search-pipeline

Search indexing as an [`@lde/pipeline`](../pipeline) Configurable Pipeline
instance: this package supplies the glue between the pipeline’s quad world
and a search engine’s document world, so indexing reuses the existing spine –
Discovery → Selection → Iteration → change-gate (skip-unchanged) – instead of
rebuilding it per consumer.

The division of labour ([ADR 6](../../docs/decisions/0006-make-the-writer-transaction-aware.md),
[ADR 13](../../docs/decisions/0013-project-inside-the-batch-per-root-type.md)):

- [`@lde/search`](../search) owns the engine-agnostic projection (framed
  document + field model) and stays pipeline-free;
- `@lde/search-<engine>` (e.g. [`@lde/search-typesense`](../search-typesense))
  is the engine adapter: a transactional, **single-collection** `Writer`
  consuming projected documents, owning the run lifecycle (Blue/green alias swap
  or In-place sweeps, cross-pod lock);
- **this package** composes them:
  - `searchStages` builds one projecting `Stage` per root type. Each stage
    selects its own roots, extracts each root’s quads, and projects the
    **root-complete batch** into documents tagged with their `SearchType`
    (`TypedSearchDocument`) – so projection happens inside the batch and memory
    is bounded by `batchSize` roots, not the dataset
    ([ADR 13](../../docs/decisions/0013-project-inside-the-batch-per-root-type.md));
  - `searchIndexWriter` is the pipeline’s single terminal: an engine-agnostic
    router that dispatches each tagged document to the engine writer for **its**
    type’s collection ([ADR 9](../../docs/decisions/0009-route-a-whole-schema-projection-to-per-type-collections.md)).
    It owns no projection and buffers nothing.

So a search pipeline is **one terminal, N stages**: `new Pipeline<TypedSearchDocument>({ datasetSelector, stages: searchStages(...), writers: searchIndexWriter(...) })`.

## Usage

```typescript
import { Pipeline, SparqlConstructReader } from '@lde/pipeline';
import { searchSchema } from '@lde/search';
import { BlueGreenRebuild } from '@lde/search-typesense';
import {
  searchStages,
  selectByClass,
  searchIndexWriter,
  type TypedSearchDocument,
} from '@lde/search-pipeline';

// One schema, several root types: the `datasets` catalog plus the Organization
// label collection its references resolve against.
const schema = searchSchema(
  {
    name: 'Dataset',
    class: 'http://www.w3.org/ns/dcat#Dataset',
    fields: [
      {
        name: 'title',
        kind: 'text',
        path: 'http://purl.org/dc/terms/title',
        locales: ['und'],
        output: true,
        searchable: { weight: 5 },
      },
    ],
  },
  {
    name: 'Organization',
    class: 'http://xmlns.com/foaf/0.1/Organization',
    fields: [
      {
        name: 'label',
        kind: 'text',
        path: 'http://xmlns.com/foaf/0.1/name',
        locales: ['und'],
        output: true,
        searchable: { weight: 1 },
      },
    ],
  },
);

const dataset = schema.get('http://www.w3.org/ns/dcat#Dataset')!;
const organization = schema.get('http://xmlns.com/foaf/0.1/Organization')!;

const pipeline = new Pipeline<TypedSearchDocument>({
  datasetSelector,
  // One stage per root type: each selects its own roots (here by class –
  // `selectByClass` is a convenience for the object grain; a deployment writes
  // its own selector where the entry point is a domain fact) and extracts each
  // root’s quads. `rootVariable` couples the selector’s projected variable to
  // what the projection reads; it must not be `dataset` (reserved by the reader).
  stages: searchStages({
    schema,
    types: [
      {
        searchType: dataset,
        rootVariable: 'root',
        itemSelector: selectByClass(dataset),
        readers: new SparqlConstructReader({ query: '…' }),
      },
      {
        searchType: organization,
        rootVariable: 'root',
        itemSelector: selectByClass(organization),
        readers: new SparqlConstructReader({ query: '…' }),
      },
    ],
  }),
  // Each type gets its own collection – an independent blue/green rebuild –
  // named by the adapter from the type itself (`Dataset` → `datasets`,
  // `Organization` → `organizations`), so no naming map is passed here and the
  // engine reading these collections cannot disagree about where they are.
  writers: searchIndexWriter({
    schema,
    writerFor: (searchType) =>
      new BlueGreenRebuild(typesenseClient, searchType),
  }),
});

await pipeline.run();
```

Collection names are the engine adapter’s to decide, not this package’s – see
[Collection naming](../search-typesense#collection-naming). A deployment that
needs other names passes one per type, and environment prefixing **composes
with** the convention rather than replacing it, since the adapter exports the
derivation:

```ts
import { BlueGreenRebuild, deriveCollectionName } from '@lde/search-typesense';

writerFor: (searchType) =>
  new BlueGreenRebuild(typesenseClient, searchType, {
    name: `${process.env.INDEX_PREFIX}_${deriveCollectionName(searchType)}`,
  });
```

Whatever the writers are named, the engine reading these collections must be
given the same names (`collections`), or it reads the derived ones and finds an
empty index.

Each stage projects its own root-complete batches (`@lde/search`’s
`projectRoots`) into documents tagged with its `SearchType`, and the terminal
dispatches each to the engine run for its type’s collection as it arrives –
before the engine acts on the dataset’s completion, so an In-place stale sweep
never races its own documents. The run lifecycle (run context, per-dataset flush
outcome, commit/abort) passes through unchanged: the engine writer’s update mode
governs, and the pipeline never branches on it, nor on how many collections
there are.

**Root selection is the deployment’s contract.** A selector that does not bind
the CONSTRUCT’s subject yields a batch that is not root-complete, and projection
will then silently emit partial documents – a promise `@lde/pipeline` cannot
check ([ADR 13](../../docs/decisions/0013-project-inside-the-batch-per-root-type.md)).
`selectByClass(searchType)` is a convenience for the object grain (where the
type’s `class` really is the source class), **not** a default.

## Per-collection isolation

Each root type is an independent engine run – its own collection, alias and
cross-pod lock – so the collections commit, sweep and fail in isolation:

- a type whose projection is empty this run affects only its own collection,
  never another’s – in particular the `datasets` index still goes live;
- `commit` finalizes every collection independently and, if any fails, throws an
  `AggregateError` _after_ attempting them all, so a non-critical
  label-collection failure never blocks the collections that did commit, while
  the failure is still surfaced (the run is marked failed);
- because the pipeline aborts a run whose `commit` throws, `abort` finalizes only
  the collections that did **not** already go live (aborting a committed
  blue/green rebuild would drop its now-live collection), dropping the half-built
  ones and releasing their locks.

See [ADR 9](../../docs/decisions/0009-route-a-whole-schema-projection-to-per-type-collections.md).

## Memory

Memory is bounded by **`batchSize` roots**, not by the input
([ADR 12](../../docs/decisions/0012-bound-memory-by-the-unit-of-work-not-the-input.md),
[ADR 13](../../docs/decisions/0013-project-inside-the-batch-per-root-type.md)).
Projection runs inside each root-complete batch and streams straight through the
terminal to the engine run, which holds only its own batch – nothing accumulates
across a dataset or across datasets, so the same pipeline indexes a 15-quad
catalog entry and a dataset of millions of objects. The one irreducible atom is a
single root’s quads: unbounded for a pathological root, and nothing here changes
that.
