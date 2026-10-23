# @lde/pipeline-logger-reporter

Reporter for [@lde/pipeline](./pipeline) that writes every [pipeline event](./pipeline#events) as a structured log line to a logger you supply, such as [Pino](https://getpino.io). The package ships no logger of its own.

## Installation

```sh
npm install @lde/pipeline-logger-reporter
```

## Usage

```typescript
import { Pipeline } from '@lde/pipeline';
import { LoggerReporter } from '@lde/pipeline-logger-reporter';
import pino from 'pino';

await new Pipeline({
  datasetSelector: selector,
  stages,
  writers,
  reporter: new LoggerReporter(pino({ level: 'info' })),
}).run();
```

`LoggerReporter` accepts any logger with structured-first `debug`/`info`/`warn`/`error(obj, msg)` methods – Pino and Bunyan as they are. A message-first logger such as Winston needs a small adapter.

## Output

Each event is logged at its [level](./pipeline#levels) with its `type` as the message. Filtering is left to the logger: at `info`, stage progress and probe results (`debug`) are dropped, while completions, skips and failures are kept.

The event is made log-friendly on the way out: a dataset is logged as its IRI, a distribution as its access URL, and an `error` under `err`, the key Pino and Bunyan serialise errors from.
