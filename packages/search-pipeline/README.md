# @lde/search-pipeline

Search indexing as an [`@lde/pipeline`](../pipeline) Configurable Pipeline
instance: this package supplies the glue between the pipeline’s quad world
and a search engine’s document world, so indexing reuses the existing spine –
Discovery → Selection → Iteration → change-gate (skip-unchanged) – instead of
rebuilding it per consumer.

The division of labour ([ADR 6](../../docs/decisions/0006-make-the-writer-transaction-aware.md)):

- [`@lde/search`](../search) owns the engine-agnostic projection (framed
  document + field model) and stays pipeline-free;
- `@lde/search-<engine>` (e.g. [`@lde/search-typesense`](../search-typesense))
  is the engine adapter: a transactional, **single-collection** `Writer`
  consuming projected documents, owning the run lifecycle (Blue/green alias swap
  or In-place sweeps, cross-pod lock);
- **this package** composes them: `searchIndexWriter` is the one type-changing
  step (quad → document), shared across engines, and – since one schema declares
  several root types – it fans each document out to the engine writer for **its**
  type’s collection ([ADR 9](../../docs/decisions/0009-route-a-whole-schema-projection-to-per-type-collections.md)).

## Usage

```typescript
import { Pipeline, Stage, SparqlConstructReader } from '@lde/pipeline';
import { searchSchema } from '@lde/search';
import { BlueGreenRebuild } from '@lde/search-typesense';
import { searchIndexWriter } from '@lde/search-pipeline';

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

const pipeline = new Pipeline({
  datasetSelector,
  stages: [
    new Stage({
      name: 'extract',
      readers: new SparqlConstructReader({ query: '…' }),
    }),
  ],
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

Each dataset’s extracted CONSTRUCT quads are buffered until the dataset
completes, then projected once over the **whole** schema (`@lde/search`’s
`projectGraph`) into one mixed, type-tagged stream, and each document is
dispatched to the engine run for its type’s collection – before the engine acts
on the dataset’s completion, so an In-place stale sweep never races its own
documents. The run lifecycle (run context, per-dataset flush outcome,
commit/abort) passes through unchanged: the engine writer’s update mode governs,
and the pipeline never branches on it, nor on how many collections there are.

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

Memory is bounded by one dataset’s extraction and released at each dataset
flush – nothing accumulates across datasets. Streaming bounded entity batches
_within_ one huge dataset needs the two-level iteration (dataset →
entity-URI batches) and is not implemented yet.
