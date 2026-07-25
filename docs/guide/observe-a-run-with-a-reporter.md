# Observe a run with a reporter

A `ProgressReporter` observes a pipeline run: it receives lifecycle events such as `datasetStart`, `stageComplete` and `pipelineComplete`. Use one to watch progress on the console, and another to collect run facts – every event method is optional, so a reporter implements only what it cares about. See the [full event table](../reference/pipeline#reporter) for everything a reporter can receive.

## Combine reporters

Pass a single reporter, or an array to have several observe the same run:

```typescript
import { ConsoleReporter } from '@lde/pipeline-console-reporter';

new Pipeline({
  // …
  reporter: [new ConsoleReporter(), collector],
});
```

Each reporter receives every event, in array order.

## Collect run facts with a custom reporter

A collector is a plain object. Events arrive in run order: datasets are processed one at a time, and `datasetStart` precedes all of that dataset’s later events – so a collector can key those events by the most recent `datasetStart`. For example, collecting each dataset’s distribution-validity verdicts:

```typescript
import type { Dataset, Distribution } from '@lde/dataset';
import type { ValidityVerdict } from '@lde/distribution-health';
import type { ProgressReporter } from '@lde/pipeline';

const verdicts = new Map<string, ValidityVerdict[]>();
let currentDataset: Dataset | undefined;

const collector: ProgressReporter = {
  datasetStart(dataset: Dataset) {
    currentDataset = dataset;
  },
  distributionValidated(distribution: Distribution, verdict: ValidityVerdict) {
    const key = currentDataset!.iri.toString();
    verdicts.set(key, [...(verdicts.get(key) ?? []), verdict]);
  },
};
```

After `pipeline.run()` resolves, `verdicts` holds every attempted distribution’s verdict per dataset – including datasets that were otherwise skipped.
