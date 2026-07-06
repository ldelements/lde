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
  is the engine adapter: a transactional `Writer` consuming projected
  documents, owning the run lifecycle (Blue/green alias swap or In-place
  sweeps, cross-pod lock);
- **this package** composes them: `searchIndexWriter` is the one
  type-changing step (quad → document), shared across engines.

## Usage

```typescript
import { Pipeline, Stage, SparqlConstructReader } from '@lde/pipeline';
import { searchSchema } from '@lde/search';
import { BlueGreenRebuild } from '@lde/search-typesense';
import { searchIndexWriter } from '@lde/search-pipeline';

const schema = searchSchema({
  name: 'dataset',
  type: 'http://www.w3.org/ns/dcat#Dataset',
  fields: [
    {
      name: 'title',
      kind: 'text',
      path: 'http://purl.org/dc/terms/title',
      locales: ['und'],
      output: true,
      searchable: true,
    },
  ],
});

const pipeline = new Pipeline({
  datasetSelector,
  stages: [
    new Stage({
      name: 'extract',
      readers: new SparqlConstructReader({ query: '…' }),
    }),
  ],
  writers: searchIndexWriter({
    schema,
    writer: new BlueGreenRebuild(
      typesenseClient,
      schema.get('http://www.w3.org/ns/dcat#Dataset')!,
      {
        name: 'datasets',
      },
    ),
  }),
});

await pipeline.run();
```

Each dataset’s extracted CONSTRUCT quads are buffered until the dataset
completes, then framed by root type and projected into flat search documents
(`@lde/search`’s `projectGraph`), and written to the engine run – before the
engine acts on the dataset’s completion, so an In-place stale sweep never
races its own documents. The run lifecycle (run context, per-dataset flush
outcome, commit/abort) passes through unchanged: the engine writer’s update
mode governs, and the pipeline never branches on it.

## Memory

Memory is bounded by one dataset’s extraction and released at each dataset
flush – nothing accumulates across datasets. Streaming bounded entity batches
_within_ one huge dataset needs the two-level iteration (dataset →
entity-URI batches) and is not implemented yet.
