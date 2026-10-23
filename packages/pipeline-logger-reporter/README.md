# @lde/pipeline-logger-reporter

Reporter for [@lde/pipeline](../pipeline) that writes every pipeline event as a structured log line to a logger you supply.

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
  reporter: new LoggerReporter(logger), // your structured logger
}).run();
```

## Documentation

See the [full documentation](https://ldelements.org/reference/pipeline-logger-reporter).
