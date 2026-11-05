# Analyze a dataset with VoID

This guide shows how to add [VoID](https://www.w3.org/TR/void/) statistics stages to a pipeline, so each run produces a statistical summary of the dataset – triple and subject counts, class and property partitions, detected vocabularies and licenses.

## Add the VoID stages

Install the VoID package alongside `@lde/pipeline`:

```sh
npm install @lde/pipeline-void
```

Then pass the bundled stages to the pipeline, with `dataset` described as in [Build a pipeline](./build-a-pipeline):

```typescript
import { voidStages } from '@lde/pipeline-void';
import { FileWriter, ManualDatasetSelection, Pipeline } from '@lde/pipeline';

await new Pipeline({
  datasetSelector: new ManualDatasetSelection([dataset]),
  stages: await voidStages(),
  writers: new FileWriter({ outputDir: './output', format: 'turtle' }),
}).run();
```

`voidStages()` returns all VoID stages in their recommended execution order, tuned so cheap queries warm the endpoint’s cache before the heavier per-class queries run. See the [@lde/pipeline-void reference](../reference/pipeline-void) for the full list of statistics and the `batchSize`, `maxConcurrency`, `perClass`, `uriSpaces`, `vocabularies` and `transforms` options.

## Pick individual statistics

When you only need some of the statistics, use the [individual stage factories](../reference/pipeline-void#individual-stage-factories) instead of the bundle:

```typescript
import { classPartitions, countTriples } from '@lde/pipeline-void';

const stages = [await classPartitions(), await countTriples()];
```

## Merge schema.org namespace variants

Datasets that mix `http://schema.org/` and `https://schema.org/` produce two partitions for one class. Add `schemaOrgPartitionMergePlugin()` to the pipeline’s `plugins` to normalize the namespace and merge the duplicate partition nodes – see [namespace normalization](../reference/pipeline-void#namespace-normalization) and [ADR 7](../decisions/0007-namespace-merge-as-a-dataset-plugin).
