# @lde/pipeline-logger-reporter

Reporter for [@lde/pipeline](./pipeline) that writes every [pipeline event](./pipeline#events) as a structured log line to a logger you supply. The package ships no logger of its own.

## Installation

```sh
npm install @lde/pipeline-logger-reporter
```

## Usage

```typescript
import { Pipeline } from '@lde/pipeline';
import { LoggerReporter } from '@lde/pipeline-logger-reporter';

await new Pipeline({
  datasetSelector: selector,
  stages,
  writers,
  reporter: new LoggerReporter(logger),
}).run();
```

`logger` is any logger with structured-first `debug`/`info`/`warn`/`error(obj, msg)` methods, such as Pino, taking the logged object first and the message second. A message-first logger needs a small adapter.

## Output

Each event is logged at its [level](./pipeline#levels) with its `type` as the message. Filtering is left to the logger: at `info`, stage progress and probe results (`debug`) are dropped, while completions, skips and failures are kept.

The event is made log-friendly on the way out: a dataset is logged as its IRI, a distribution – including an import’s `imported.from` – as its access URL, and an `error` under `err`, the key structured loggers conventionally serialise errors from. `pipelineStart`’s `name` is logged as `pipeline`, because structured loggers reserve `name` for their own. Every other value is passed through as is, so serialising it – URLs, dates, nested objects, cycles – is up to your logger; Pino handles all of these. `defaultLevel` is left out, as it already is the line’s level. To get the pipeline name on every line, bind it on the logger itself, for example with a child logger.

If your logger has an `isLevelEnabled(level)` method, as Pino does, the reporter asks it first and skips building the log line for events the logger would drop.
