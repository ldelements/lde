# @lde/pipeline-console-reporter

Console progress reporter for [@lde/pipeline](../pipeline). Displays real-time pipeline progress with spinners, colours and timing information.

## Installation

```sh
npm install @lde/pipeline-console-reporter
```

## Usage

```typescript
import { Pipeline } from '@lde/pipeline';
import { ConsoleReporter } from '@lde/pipeline-console-reporter';

await new Pipeline({
  datasetSelector: selector,
  stages,
  writers,
  reporter: new ConsoleReporter(),
}).run();
```

## Documentation

See the [full documentation](https://ldelements.org/reference/pipeline-console-reporter).
