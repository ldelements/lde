# Observe a run with a reporter

A reporter observes a pipeline run: the pipeline hands it every event – `datasetStart`, `stageComplete`, `pipelineComplete` and so on – as one `PipelineEvent` value through its `onEvent` method. Each event carries a `type`, a severity `level`, a `timestamp`, the `runId` of its run and, from `datasetStart` on, the `dataset` it belongs to. Use one reporter to watch progress on the console, another to log to your own logger, and a custom one to collect run facts. See the [full event table](../reference/pipeline#events) for everything a reporter can receive.

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

## Log to your own logger

In production you usually want structured log lines rather than spinners. `LoggerReporter` from [@lde/pipeline-logger-reporter](../reference/pipeline-logger-reporter) writes one line per event to your application’s structured logger, at the event’s level:

```typescript
import { LoggerReporter } from '@lde/pipeline-logger-reporter';

new Pipeline({
  // …
  reporter: new LoggerReporter(logger),
});
```

The logger’s own level decides what is written: at `info`, stage progress and probe results (`debug`) are dropped, while completions, skips and failures are kept.

## Collect run facts with a custom reporter

A reporter is any object with an `onEvent` method. Switch on `type` to handle the events you care about; the event narrows to its own type in each branch. For example, collecting each dataset’s distribution-validity verdicts:

```typescript
import type { ValidityVerdict } from '@lde/distribution-health';
import type { Reporter } from '@lde/pipeline';

const verdicts = new Map<string, ValidityVerdict[]>();

const collector: Reporter = {
  onEvent(event) {
    if (event.type !== 'distributionValidated') return;
    const key = event.dataset.iri.toString();
    verdicts.set(key, [...(verdicts.get(key) ?? []), event.verdict]);
  },
};
```

After `pipeline.run()` resolves, `verdicts` holds every attempted distribution’s verdict per dataset – including datasets that were otherwise skipped.

## Change an event’s severity

An event’s `level` is the pipeline’s default. To treat something as more or less severe, remap on `type` and the structured payload – for example, to raise every skipped dataset except an unchanged one to `error` before handing it on:

```typescript
import type { PipelineEvent, Reporter } from '@lde/pipeline';

function escalateSkips(reporter: Reporter): Reporter {
  return {
    onEvent(event: PipelineEvent) {
      if (
        event.type === 'datasetSkipped' &&
        event.reason.code !== 'unchanged'
      ) {
        return reporter.onEvent({ ...event, level: 'error' });
      }
      reporter.onEvent(event);
    },
  };
}
```
