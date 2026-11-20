# Chain stage outputs

This guide shows how to feed one stage’s output to sub-stages that query it, and how to choose which stages’ output the chain writes.

## Declare sub-stages

Pass child stages in the parent’s `stages` option. Each child queries the previous stage’s output instead of the dataset’s own distribution. A chain is a line, not a tree: the second child queries the first child’s output, not the parent’s. To run several queries over the same output, give one child several readers:

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

## Choose what the chain writes

The parent’s `chainOutput` option decides which stages’ output reaches the pipeline’s [writers](../reference/pipeline#writer). Pick it by what the later stages do with the earlier output.

### Enrich: write every stage

Use the default, `chainOutput: 'all'`, when each stage adds to the result. A typical case is enrichment: the parent produces your data, and a chained stage selects the terms it links to and fetches their labels from another SPARQL endpoint. The chained stage’s item selector queries the parent’s output; its reader queries the other endpoint for the selected terms:

```typescript
import { Distribution } from '@lde/dataset';
import {
  SparqlConstructReader,
  SparqlItemSelector,
  Stage,
} from '@lde/pipeline';
import type { Reader } from '@lde/pipeline';

const terminology = Distribution.sparql(
  new URL('https://terminology.example.org/sparql'),
);
const labels = await SparqlConstructReader.fromFile('term-labels.rq');

// Query the terminology endpoint instead of the parent’s output.
const termLabels: Reader = {
  read: (dataset, _distribution, options) =>
    labels.read(dataset, terminology, options),
};

const parent = new Stage({
  name: 'map',
  readers: await SparqlConstructReader.fromFile('map.rq'),
  stages: [
    new Stage({
      name: 'enrich',
      itemSelector: new SparqlItemSelector({
        query:
          'SELECT DISTINCT ?this WHERE { ?record <https://schema.org/about> ?this } ORDER BY ?this',
      }),
      readers: termLabels,
      // Chained stages are tuned for the pipeline’s own store; set
      // what suits the remote endpoint.
      batchSize: 50,
      maxConcurrency: 2,
    }),
  ],
});
```

The writers get the mapped data and the labels together. If the mapped data links to no terms, the enrich stage selects nothing and the writers get the mapped data alone.

A chained stage runs with the batch size and concurrency meant for the store that serves its parent’s output. A stage whose reader queries a remote endpoint should set `batchSize` and `maxConcurrency` for that endpoint, as above.

### Normalise, then map: write only the last stage

Set `chainOutput: 'last'` when the earlier stages only produce input for the next one. A typical case is a shared mapping that expects its input in one shape: a first stage normalises each source to that shape, and the mapping reads the normalised output. The normalised data is scaffolding, so only the mapping’s output should reach the writers:

```typescript
const parent = new Stage({
  name: 'normalise',
  readers: await SparqlConstructReader.fromFile('normalise.rq'),
  chainOutput: 'last', // only 'map' reaches the writers
  stages: [
    new Stage({
      name: 'map',
      readers: await SparqlConstructReader.fromFile('map.rq'),
    }),
  ],
});
```

Without `'last'`, the writers would get the normalised data as well as the mapped data, and whatever reads the output would have to filter the normalised data back out.

The stages `'last'` leaves out still run their [validation](../reference/pipeline#validation), and its results are reported – useful for checking that the normalised data has the shape the mapping expects.

### Inspect the output between stages

Whichever you choose, every stage in the chain keeps its own scratch file at `<outputDir>/<stage name>/<dataset>.nt` after the run, including the stages `'last'` leaves out of what the chain writes. Compare one stage’s file with the next to see how a query acts on the previous one’s output. The next run of the dataset overwrites the files.

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
3. The scratch files the parent’s `chainOutput` selects – all of them by default, or only the last stage’s – are concatenated and written to the pipeline’s [writers](../reference/pipeline#writer) under the parent stage’s name. The scratch files stay on disk.
4. `cleanup()` runs when the chain finishes, on success and on failure.

Two constraints apply:

- Chains are quad-only: a stage with `stages` cannot `project`, because a chained stage serialises to N-Triples, which a projected item cannot (see [ADR 13](../decisions/0013-project-inside-the-batch-per-root-type)).
- A chain is one line: a chained stage cannot have `stages` of its own, and the stages in a chain need distinct names, because each writes its scratch file under its name.
- A chained stage whose item selector selects nothing produces empty output, and the chain continues. Any other `NotSupported` – every reader returning it – fails the whole chain instead of being skipped, because the stage produced no output for the next one to read.
