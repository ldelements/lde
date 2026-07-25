# @lde/pipeline-console-reporter

Console progress reporter for [@lde/pipeline](./pipeline). Displays real-time pipeline progress with spinners, colours and timing information.

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

`ConsoleReporter` takes no constructor options.

## Output

The reporter covers the whole pipeline lifecycle: a per-dataset header with a `[current/total]` counter, distribution probe results (endpoint type, HTTP status, warnings), an import spinner with a live elapsed-time counter, per-stage progress (items processed, quads generated, elapsed time, RSS and heap memory), validation summaries (quads validated, violation counts), adaptive-timeout transitions (tighten/relax lines per endpoint), and dataset/pipeline completion lines with duration and memory usage.

All output goes to **stderr** – deliberately, so stdout stays clean for pipeline data and the reporter can be combined with output redirection.

The reporter is TTY-aware: on a TTY it shows animated spinners and rewrites the selected distribution’s probe line in place; on a non-TTY stream (CI logs, redirected output) it prints plain lines instead.
