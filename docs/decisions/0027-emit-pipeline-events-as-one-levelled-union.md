# 27. Emit pipeline events as one levelled union

Date: 2026-10-23

## Status

Proposed

## Context

`@lde/pipeline` reports what it does through `ProgressReporter`, an interface of roughly twenty optional lifecycle methods (`datasetStart`, `stageProgress`, `importFailed`, …). The pipeline calls them directly at each point of interest – `this.reporter?.stageFailed?.(stage.name, error)` – and `combineReporters` fans a reporter array out into one. The only implementation shipped is `ConsoleReporter` in `@lde/pipeline-console-reporter`: ora spinners, chalk colours and ANSI cursor movement, built for a human watching a terminal.

That model serves local runs well and production runs badly:

1. **No route into the caller’s logger.** An operator running a pipeline in a container wants structured lines in their own logger (a structured logger, an OpenTelemetry exporter, plain JSON on stdout), not spinners. Getting there means writing a twenty-method reporter by hand, and the `search-indexer` CLI offers no alternative at all – it hardcodes `new ConsoleReporter()`.
2. **Events are not self-contained.** `stageStart(stage)`, `stageProgress(update)` and `importStarted()` do not say which dataset they belong to; `stageProgress` does not even name its stage. A reporter must reconstruct ‘where am I’ from the order of earlier calls, which is why `ConsoleReporter` keeps that state in instance fields. A structured log line without its dataset is useless once it is aggregated.
3. **Severity is implicit.** Whether something deserves attention is sometimes a property of the payload, not the method: `datasetSkipped` with ‘Unchanged since last run’ is routine, while the same method after every distribution failed means data was not indexed. A consumer can only tell the two apart by matching reason strings.
4. **Errors are flattened.** `importFailed(distribution, error: string)` drops the stack and type a structured logger would serialise.

Established Node libraries solve the first point by staying silent by default and either accepting a logger of a widely shared shape (Fastify’s `loggerInstance`, the AWS SDK v3 `logger` client option, KafkaJS’s `logCreator`) or publishing structured events that consumers subscribe to (undici over `node:diagnostics_channel`). The pipeline already stays silent and already publishes events; what it lacks is an event shape that a generic consumer can handle without knowing every method.

Two shapes were weighed for delivery:

- **`Pipeline extends EventEmitter`.** Call sites would barely change – `this.emit('stageFailed', …)` is as manual as the reporter call it replaces – while the pipeline’s public surface would gain the emitter’s whole API (`removeAllListeners`, `setMaxListeners`, the listener-count leak warning), and an event typed `'error'` would throw when unhandled. Typing is not the obstacle (`@types/node` types `EventEmitter<T>`); the obstacle is that the emitter adds API without adding structure.
- **A discriminated union passed to reporters.** Every event becomes a plain object with a `type` discriminator, handed to one `onEvent` method. That is the change that actually helps: a generic consumer handles every event in one place, events serialise and forward unchanged, and tests assert on collected arrays.

## Decision

The pipeline emits every observable occurrence as one value of a discriminated union, `PipelineEvent`, delivered to caller-supplied reporters.

### One type per event, one union

Each event is its own exported type, carrying the shared envelope plus its own payload; `PipelineEvent` is their union:

```ts
type Level = 'debug' | 'info' | 'warn' | 'error';

interface EventEnvelope<Type extends string> {
  type: Type;
  defaultLevel: Level;
  timestamp: Date;
  runId: string;
}

interface DatasetEventEnvelope<Type extends string>
  extends EventEnvelope<Type> {
  dataset: Dataset;
}

interface PipelineStartEvent extends EventEnvelope<'pipelineStart'> {
  name: string;
}

interface StageCompleteEvent extends DatasetEventEnvelope<'stageComplete'> {
  stage: string;
  itemsProcessed: number;
  quadsGenerated: number;
  durationMs: number;
}

interface DatasetSkippedEvent extends DatasetEventEnvelope<'datasetSkipped'> {
  reason: {
    code:
      | 'unchanged'
      | 'probeFailed'
      | 'resolveFailed'
      | 'noDistributionAvailable';
    message: string;
  };
}

interface ImportFailedEvent extends DatasetEventEnvelope<'importFailed'> {
  distribution: Distribution;
  error: Error;
}

// … one type per occurrence the pipeline reports today

type PipelineEvent =
  | PipelineStartEvent
  | StageCompleteEvent
  | DatasetSkippedEvent
  | ImportFailedEvent
  | …;
```

The discriminator lives in the envelope: an event type cannot extend `EventEnvelope` without naming its `type` literal, so no future event can join the union without one. Individual types let a reporter name exactly what it handles, and they make the context each event carries part of its type. Every event that belongs to one dataset extends `DatasetEventEnvelope`, so its `dataset` is guaranteed and a generic consumer finds it with a single `'dataset' in event` check; run-level events such as `pipelineStart` and `pipelineComplete` keep the plain envelope, so `dataset` is never optional. Stage-scoped events add a required `stage`.

### Severity as a library default

The `defaultLevel` field is the pipeline’s judgement of how loud an event should be, computed in one place (a `levelOf(event)` table), never at the sites that report an event. It uses exactly four levels – the common subset of popular Node loggers, the console, OpenTelemetry severity and KafkaJS – and deliberately no `fatal`: the library never ends the process, and an unrecoverable failure surfaces as a rejection from `run()`.

The initial mapping:

| Level   | Events                                                                                                                                                                                                        |
| ------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `debug` | `stageProgress`, `distributionProbed`, `importStarted`, `stageStart`                                                                                                                                          |
| `info`  | `pipelineStart`, `pipelineComplete`, `datasetsSelected`, `datasetStart`, `datasetComplete`, `distributionSelected`, `stageComplete`, `timeoutRelaxed`, `datasetSkipped` (`unchanged`), valid verdicts/reports |
| `warn`  | `selectionEmpty`, `datasetSkipped` (any other reason), `importFailed`, `stageSkipped`, `itemsRejected`, `timeoutTightened`, invalid `distributionValidated`, non-conforming `datasetValidated`                |
| `error` | `stageFailed`                                                                                                                                                                                                 |

The level is a default, not a verdict. A deployment that wants a skipped dataset to page someone remaps on `type` and the structured payload; for that to be possible, skip and failure reasons become `{ code, message }` objects instead of free strings, and failures carry `Error` values instead of messages.

### Delivery

Events go to reporters: objects implementing a single `onEvent` method, passed through the existing `reporter` option as one reporter or an array:

```ts
interface Reporter {
  onEvent(event: PipelineEvent): void;
}

new Pipeline({
  // …
  reporter: [new ConsoleReporter(), new LoggerReporter(logger)],
});
```

An object rather than a bare callback matches the pipeline’s other extension points (writers, validators, provenance stores), lets a reporter be a class that holds rendering state, and leaves room for optional lifecycle methods later – a `flush()` for a buffered log file, say – without another option. The pipeline calls `reporter.onEvent(event)` as a method, so `this` is bound without care from the implementer.

Reporters run synchronously in array order; a throwing reporter propagates into the run. Each reporter decides what to do with the level. `LoggerReporter` defers to the logger’s configured level, so a log file can record `debug` or only `warn`. `ConsoleReporter` renders every event and uses the level only to choose how a line looks: its spinners, dataset headers and probe lines build on earlier events, so filtering some out would leave the rest without their context.

The array is the only way to combine reporters; no combining utility is exported alongside it, so there is one way to do it.

### Replace `ProgressReporter` with `Reporter`

Once the pipeline reports through `onEvent`, none of `ProgressReporter`’s twenty methods is called any more, so the interface is replaced by `Reporter` rather than kept under its old name. Every existing implementation has to be rewritten either way, so keeping the name would only spare a few imports. A removed export tells an upgrading implementer that the contract changed; the same name with a different shape would instead surface as a puzzling missing-`onEvent` error. ‘Progress’ also no longer describes the interface, which now carries warnings, failures and skips for production logging.

`combineReporters` existed only to forward those twenty methods; fanning out to an array is a loop inside the pipeline, so it is removed.

### Consumers

- A new package, `@lde/pipeline-logger-reporter`, sits beside `@lde/pipeline-console-reporter` and exports `LoggerReporter`. It ships no logger: it accepts any object with structured-first `debug`/`info`/`warn`/`error(obj, msg)` methods and writes one structured line per event – `logger[event.defaultLevel](event, event.type)` in essence. A message-first logger needs a small adapter.
- `ConsoleReporter` stays a class and switches on `event.type` inside `onEvent`. Because events now carry their own dataset and stage, it keeps only the state it needs for rendering (the active spinner, the probe lines).

## Consequences

- Wiring a pipeline into a production logger becomes one line.
- The `search-indexer` image keeps its `ConsoleReporter`. Structured logs there would mean choosing a logger, which belongs to the deployment rather than to the library, so that is left open.
- Every consumer of `ProgressReporter` migrates: `ConsoleReporter`, `searchIndexerPipeline`’s `reporter` option, the reporters in tests, and the ‘Observe a run with a reporter’ guide plus the `pipeline` and `pipeline-console-reporter` reference pages. Pre-release this is accepted.
- A reporter interested in three events now implements one `onEvent` that ignores the rest, instead of three optional methods. For generic reporters (loggers, forwarders, test collectors) this is simpler; for narrow ones it is a `switch` with a default branch.
- Reporters do not switch exhaustively on `type`: an event a reporter does not handle is ignored. Adding an event type is therefore not a breaking change – existing reporters keep working and simply skip the new event until they choose to handle it.
- Severity is now a library contract. Changing an event’s default level is a behaviour change for anyone filtering on it, and is called out in the changelog like any other.
- Memory and heap figures stay on `stageProgress` and `datasetComplete` for now. They are metrics rather than logs; a metrics and tracing route is left to a later decision.
- `distribution-downloader`’s own `Logger` interface is unaffected by this record. Aligning the library-wide logger shape with the one `LoggerReporter` accepts is a natural follow-up.

## Future work

Not part of this decision, proposed for the later metrics and tracing decision: publishing dataset and stage lifecycles on `node:diagnostics_channel`, for instance as `tracingChannel` spans. APM and OpenTelemetry tooling could then observe any pipeline in the process without a reference to its instance. It is deferred because nothing needs it yet and channel names become public API.
