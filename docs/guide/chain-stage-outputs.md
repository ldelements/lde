# Chain stage outputs

This guide shows how to feed one stage’s output to sub-stages that query it – for example an extraction stage whose result a second stage aggregates.

## Declare sub-stages

Pass child stages in the parent’s `stages` option. Each child queries the previous stage’s output instead of the dataset’s own distribution:

```typescript
import { SparqlConstructReader, Stage } from '@lde/pipeline';

const parent = new Stage({
  name: 'extract',
  readers: await SparqlConstructReader.fromFile('extract.rq'),
  stages: [
    new Stage({
      name: 'aggregate',
      readers: await SparqlConstructReader.fromFile('aggregate.rq'),
    }),
  ],
});
```

## Implement a stage output resolver

Between stages, the pipeline writes output to a scratch N-Triples file. A `StageOutputResolver` turns that file into the `Distribution` the next stage queries:

```typescript
import { Distribution } from '@lde/dataset';
import type { StageOutputResolver } from '@lde/pipeline';
import {
  startSparqlEndpoint,
  teardownSparqlEndpoint,
} from '@lde/local-sparql-endpoint';

const port = 3001;

const stageOutputResolver: StageOutputResolver = {
  async resolve(outputPath: string): Promise<Distribution> {
    await startSparqlEndpoint(port, outputPath);
    return Distribution.sparql(new URL(`http://localhost:${port}/sparql`));
  },
  async cleanup(): Promise<void> {
    await teardownSparqlEndpoint();
  },
};
```

This implementation serves the file from a local Comunica endpoint ([@lde/local-sparql-endpoint](../reference/local-sparql-endpoint)); any implementation that makes the file queryable as a `Distribution` works.

## Enable chaining

`chaining` is required as soon as any stage has sub-stages – the `Pipeline` constructor throws without it:

```typescript
const pipeline = new Pipeline({
  datasetSelector,
  stages: [parent],
  writers,
  chaining: {
    stageOutputResolver,
    outputDir: './scratch',
  },
});
```

## How a chain runs

For each dataset:

1. The parent stage runs against the dataset’s resolved distribution and writes N-Triples to a scratch file under `<outputDir>/<stage name>/`.
2. `resolve()` turns that file into a `Distribution`; the first sub-stage runs against it, writing its own scratch file. Each further sub-stage chains off the previous one’s output the same way.
3. The scratch files of the whole chain are concatenated and written to the pipeline’s [writers](../reference/pipeline#writer) under the parent stage’s name.
4. `cleanup()` runs when the chain finishes, on success and on failure.

Two constraints apply:

- Chains are quad-only: a stage with `stages` cannot `project`, because a chained stage serialises to N-Triples, which a projected item cannot (see [ADR 13](../decisions/0013-project-inside-the-batch-per-root-type)).
- A chained stage that returns `NotSupported` – for example, its item selector selects nothing – fails the whole chain instead of being skipped, because a later stage cannot chain off missing output.
