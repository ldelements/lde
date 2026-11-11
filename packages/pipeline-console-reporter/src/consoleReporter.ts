import type {
  DatasetCompleteEvent,
  DatasetSkippedEvent,
  DatasetStartEvent,
  DatasetValidatedEvent,
  DatasetsSelectedEvent,
  DistributionProbedEvent,
  DistributionSelectedEvent,
  ImportFailedEvent,
  ItemsRejectedEvent,
  PipelineCompleteEvent,
  PipelineEvent,
  Reporter,
  RootSkippedEvent,
  SelectionEmptyEvent,
  StageCompleteEvent,
  StageFailedEvent,
  StagePhases,
  StageProgressEvent,
  StageSkippedEvent,
  StageStartEvent,
  TimeoutRelaxedEvent,
  TimeoutTightenedEvent,
  ValuesUnreadEvent,
} from '@lde/pipeline';
import chalk from 'chalk';
import logSymbols from 'log-symbols';
import ora, { type Ora } from 'ora';
import prettyMilliseconds from 'pretty-ms';

const compactNumber = new Intl.NumberFormat('en', {
  notation: 'compact',
  maximumFractionDigits: 1,
});

function formatBytes(bytes: number): string {
  const megabytes = bytes / 1024 / 1024;
  return `${megabytes.toFixed(0)} MB`;
}

/**
 * {@link Reporter} that renders a run on stderr for a human at a terminal.
 *
 * It renders every event: spinners, the dataset header and the probe lines
 * depend on earlier events, so it does not filter by level. For level-filtered
 * output, use a structured logger instead.
 */
export class ConsoleReporter implements Reporter {
  private activeSpinner?: Ora;
  private stageStartTime = 0;
  private datasetTotal = 0;
  private datasetIndex = 0;
  private importTimer?: ReturnType<typeof setInterval>;
  private probeLines: { url: string; text: string }[] = [];

  onEvent(event: PipelineEvent): void {
    switch (event.type) {
      case 'pipelineStart':
        return this.pipelineStart();
      case 'datasetsSelected':
        return this.datasetsSelected(event);
      case 'selectionEmpty':
        return this.selectionEmpty(event);
      case 'datasetStart':
        return this.datasetStart(event);
      case 'distributionProbed':
        return this.distributionProbed(event);
      case 'importStarted':
        return this.importStarted();
      case 'importFailed':
        return this.importFailed(event);
      case 'distributionSelected':
        return this.distributionSelected(event);
      case 'stageStart':
        return this.stageStart(event);
      case 'stageProgress':
        return this.stageProgress(event);
      case 'stageComplete':
        return this.stageComplete(event);
      case 'stageFailed':
        return this.stageFailed(event);
      case 'stageSkipped':
        return this.stageSkipped(event);
      case 'rootSkipped':
        return this.rootSkipped(event);
      case 'datasetValidated':
        return this.datasetValidated(event);
      case 'datasetComplete':
        return this.datasetComplete(event);
      case 'datasetSkipped':
        return this.datasetSkipped(event);
      case 'itemsRejected':
        return this.itemsRejected(event);
      case 'valuesUnread':
        return this.valuesUnread(event);
      case 'pipelineComplete':
        return this.pipelineComplete(event);
      case 'timeoutTightened':
        return this.timeoutTightened(event);
      case 'timeoutRelaxed':
        return this.timeoutRelaxed(event);
      case 'distributionValidated':
        // The probe and import lines already show the operator the outcome.
        return;
      default:
        event satisfies never;
    }
  }

  /** Print a static line with a symbol prefix. */
  private printLine(symbol: string, text: string, indent = 0): void {
    process.stderr.write(`${'  '.repeat(indent)}${symbol} ${text}\n`);
  }

  /** Stop any active spinner and start a new one. */
  private startSpinner(text: string, indent = 0): Ora {
    this.activeSpinner?.stop();
    this.clearImportTimer();
    const padding = '  '.repeat(indent);
    this.activeSpinner = ora({
      discardStdin: false,
      prefixText: padding,
    }).start(text);
    return this.activeSpinner;
  }

  private pipelineStart(): void {
    this.startSpinner('Selecting datasets');
  }

  private datasetsSelected({ count, durationMs }: DatasetsSelectedEvent): void {
    this.datasetTotal = count;
    if (this.activeSpinner) {
      this.activeSpinner.text = `Selected datasets: found ${chalk.bold(count)} ${
        count === 1 ? 'dataset' : 'datasets'
      } in ${chalk.bold(prettyMilliseconds(durationMs))}`;
    }
  }

  private selectionEmpty({ message: reason }: SelectionEmptyEvent): void {
    // A run that changed nothing on purpose – loud enough to notice on a cron,
    // because the usual cause is an outage or a criteria typo rather than a
    // genuinely empty registry. Printed either way: a spinner is only running
    // when the pipeline reached selection through `pipelineStart`, and the
    // warning matters most precisely where it did not.
    if (this.activeSpinner) {
      this.activeSpinner.warn(chalk.yellow(reason));
      this.activeSpinner = undefined;
      return;
    }
    this.printLine(logSymbols.warning, chalk.yellow(reason));
  }

  private datasetStart({ dataset }: DatasetStartEvent): void {
    this.activeSpinner?.succeed();
    this.activeSpinner = undefined;
    this.clearImportTimer();
    this.probeLines = [];
    this.datasetIndex++;
    const counter =
      this.datasetTotal > 1
        ? ` ${chalk.dim(`[${this.datasetIndex}/${this.datasetTotal}]`)}`
        : '';
    process.stderr.write(
      `\nDataset ${chalk.bold(dataset.iri.toString())}${counter}\n`,
    );
  }

  private distributionProbed({
    distribution,
    result,
  }: DistributionProbedEvent): void {
    const url = distribution.accessUrl.toString();
    const typeLabel =
      result.type === 'sparql'
        ? 'SPARQL endpoint'
        : result.type === 'data-dump'
          ? 'Data dump'
          : 'Network error';

    if (result.available) {
      const detail =
        result.statusCode !== undefined ? ` (HTTP ${result.statusCode})` : '';
      const text = `${typeLabel} ${url}${detail}`;
      this.printLine(logSymbols.success, text, 1);
      this.probeLines.push({ url, text });
      for (const warning of result.warnings) {
        this.printLine(logSymbols.warning, warning, 1);
      }
    } else {
      const detail = result.error
        ? ` (${result.error})`
        : result.statusCode !== undefined
          ? ` (HTTP ${result.statusCode})`
          : '';
      this.printLine(logSymbols.error, `${typeLabel} ${url}${detail}`, 1);
      this.probeLines.push({ url, text: '' });
    }
  }

  private importStarted(): void {
    const importStart = Date.now();
    const spinner = this.startSpinner('Importing\u2026', 1);
    this.importTimer = setInterval(() => {
      if (spinner.isSpinning) {
        spinner.suffixText = prettyMilliseconds(Date.now() - importStart);
      }
    }, 1_000);
  }

  private importFailed({ error }: ImportFailedEvent): void {
    const text = `Import failed: ${error.message}`;
    if (this.activeSpinner) {
      this.activeSpinner.text = text;
      this.activeSpinner.suffixText = '';
      this.activeSpinner.fail();
    } else {
      this.printLine(logSymbols.error, text, 1);
    }
    this.clearImportTimer();
    this.activeSpinner = undefined;
  }

  private distributionSelected({
    distribution,
    imported,
  }: DistributionSelectedEvent): void {
    if (imported) {
      const engine = imported.engine
        ? ` into ${imported.engine.name} ${imported.engine.version}`
        : '';
      const count =
        imported.tripleCount !== undefined
          ? `${compactNumber.format(imported.tripleCount)} triples, `
          : '';
      const duration = ` in ${chalk.bold(prettyMilliseconds(imported.durationMs))}`;
      const text = `Imported ${imported.from.accessUrl.toString()}${engine} (${count}to ${distribution.accessUrl.toString()})${duration}`;
      if (this.activeSpinner) {
        this.activeSpinner.text = text;
        this.activeSpinner.suffixText = '';
        this.activeSpinner.succeed();
      } else {
        this.printLine(logSymbols.success, text, 1);
      }
      this.clearImportTimer();
      this.activeSpinner = undefined;
    } else {
      this.clearImportTimer(); // defensive – prevents leaks from a previous dataset
      const url = distribution.accessUrl.toString();
      const probe = this.probeLines.find((line) => line.url === url);
      const text = probe?.text || url;
      const selectedText = `${text} ${chalk.green('(selected)')}`;

      if (probe?.text && process.stderr.isTTY) {
        const linesUp = this.probeLines.length - this.probeLines.indexOf(probe);
        // Move cursor up to the probe line and clear it.
        process.stderr.write(`\x1B[${linesUp}A\x1B[2K\r`);
        this.printLine(logSymbols.success, selectedText, 1);
        // Move cursor back down to original position.
        if (linesUp > 1) {
          process.stderr.write(`\x1B[${linesUp - 1}B`);
        }
      } else {
        this.printLine(logSymbols.success, selectedText, 1);
      }
    }
  }

  private clearImportTimer(): void {
    if (this.importTimer) {
      clearInterval(this.importTimer);
      this.importTimer = undefined;
    }
  }

  private stageStart({ stage }: StageStartEvent): void {
    this.stageStartTime = Date.now();
    this.startSpinner(`Stage ${chalk.bold(stage)}`, 1);
  }

  private stageProgress(update: StageProgressEvent): void {
    if (this.activeSpinner) {
      const elapsed = prettyMilliseconds(Date.now() - this.stageStartTime);
      this.activeSpinner.suffixText = `${compactNumber.format(
        update.itemsProcessed,
      )} items, ${compactNumber.format(
        update.quadsGenerated,
      )} quads, ${elapsed}, memory: ${formatBytes(update.memoryUsageBytes)} RSS, ${formatBytes(update.heapUsedBytes)} heap`;
    }
  }

  private stageComplete(result: StageCompleteEvent): void {
    if (this.activeSpinner) {
      const counts =
        result.itemsProcessed > 0
          ? ` ${compactNumber.format(result.itemsProcessed)} items, ${compactNumber.format(result.quadsGenerated)} quads,`
          : '';
      this.activeSpinner.suffixText = '';
      this.activeSpinner.text = `${this.activeSpinner.text}${counts} took ${chalk.bold(
        prettyMilliseconds(result.durationMs),
      )}${result.phases ? phasesSummary(result.phases) : ''}${countsSummary(result.counts)}`;
      this.activeSpinner.succeed();
      this.activeSpinner = undefined;
    }
  }

  private stageFailed({ stage, error }: StageFailedEvent): void {
    if (this.activeSpinner) {
      this.activeSpinner.suffixText = chalk.red(error.message);
      this.activeSpinner.fail();
      this.activeSpinner = undefined;
    } else {
      // The pipeline also reports failures outside any stage – a writer
      // flush, a provenance write, the reactive dump fallback – where no
      // spinner is running. Those must leave a trace too: a failure that
      // prints nothing is worse than the failure itself.
      this.printLine(
        logSymbols.error,
        `${chalk.bold(stage)} failed: ${chalk.red(error.message)}`,
        1,
      );
    }
  }

  private datasetValidated({ report }: DatasetValidatedEvent): void {
    if (report.conforms) {
      this.printLine(
        logSymbols.success,
        `Validated ${compactNumber.format(report.quadsValidated)} quads`,
        2,
      );
    } else {
      this.printLine(
        logSymbols.error,
        `Validated ${compactNumber.format(report.quadsValidated)} quads: ${chalk.red(`${compactNumber.format(report.violations)} violation(s)`)}`,
        2,
      );
    }
  }

  private stageSkipped({ reason }: StageSkippedEvent): void {
    if (this.activeSpinner) {
      if (reason.code === 'noItemsSelected') {
        // The stage does not apply to this dataset: not a failure.
        this.activeSpinner.suffixText = `skipped: ${chalk.dim(reason.message)}`;
        this.activeSpinner.info();
      } else {
        this.activeSpinner.suffixText = `skipped: ${chalk.red(reason.message)}`;
        this.activeSpinner.fail();
      }
      this.activeSpinner = undefined;
    }
  }

  private rootSkipped({ stage, root, error }: RootSkippedEvent): void {
    const names = Object.values(root)
      .map((term) => term.value)
      .join(', ');
    this.printLine(
      logSymbols.warning,
      `${chalk.bold(stage)}: skipped ${names} ${chalk.dim(`(${error.message.split('\n')[0]})`)}`,
      2,
    );
  }

  private datasetComplete(result: DatasetCompleteEvent): void {
    this.printLine(
      logSymbols.success,
      `Completed in ${chalk.bold(prettyMilliseconds(result.durationMs))} ${chalk.dim(`(memory: ${formatBytes(result.memoryUsageBytes)} RSS, ${formatBytes(result.heapUsedBytes)} heap)`)}`,
      1,
    );
  }

  private datasetSkipped({ reason }: DatasetSkippedEvent): void {
    if (reason.code === 'unchanged') {
      this.printLine(logSymbols.info, `Skipped: ${reason.message}`, 1);
      return;
    }
    this.printLine(
      logSymbols.error,
      `Skipped: ${chalk.red(reason.message)}`,
      1,
    );
  }

  private itemsRejected({ rejection }: ItemsRejectedEvent): void {
    const { target, written, rejected, reasons } = rejection;
    this.printLine(
      logSymbols.warning,
      `${chalk.bold(target)}: ${compactNumber.format(written - rejected)} of ${compactNumber.format(written)} items written, ${chalk.yellow(`${compactNumber.format(rejected)} rejected`)}`,
      1,
    );
    for (const { reason, count, examples } of reasons) {
      this.printLine(
        logSymbols.warning,
        `${compactNumber.format(count)} × ${reason} ${chalk.dim(`(e.g. ${examples.join(', ')})`)}`,
        2,
      );
    }
  }

  private valuesUnread({ unread }: ValuesUnreadEvent): void {
    const { target, field, examples } = unread;
    const count = compactNumber.format(unread.unread);
    this.printLine(
      logSymbols.warning,
      `${chalk.bold(target)}: ${chalk.yellow(`${count} ${field} ${unread.unread === 1 ? 'value' : 'values'} unread`)}`,
      1,
    );
    for (const { id, value } of examples) {
      this.printLine(
        logSymbols.warning,
        `${JSON.stringify(truncated(value))} ${chalk.dim(`on ${id}`)}`,
        2,
      );
    }
  }

  private pipelineComplete(result: PipelineCompleteEvent): void {
    process.stderr.write(
      `\nPipeline completed in ${chalk.bold(
        prettyMilliseconds(result.durationMs),
      )} ${chalk.dim(`(memory: ${formatBytes(result.memoryUsageBytes)} RSS, ${formatBytes(result.heapUsedBytes)} heap)`)}\n`,
    );
  }

  private timeoutTightened(event: TimeoutTightenedEvent): void {
    this.printLine(
      chalk.yellow('↘'),
      `Tightened timeout for ${event.endpoint.toString()} to ${chalk.bold(
        prettyMilliseconds(event.toTimeoutMs),
      )} after ${chalk.bold(event.consecutiveTimeouts)} consecutive timeouts`,
      2,
    );
  }

  private timeoutRelaxed(event: TimeoutRelaxedEvent): void {
    this.printLine(
      chalk.green('↗'),
      `Relaxed timeout for ${event.endpoint.toString()} back to ${chalk.bold(
        prettyMilliseconds(event.toTimeoutMs),
      )} after successful request`,
      2,
    );
  }
}

/**
 * Where a stage spent its time, as a dimmed suffix, leaving out phases it spent
 * no time in. Labelled `busy` because the phases add up over batches running at
 * once, so together they can exceed the stage’s duration.
 */
function phasesSummary(phases: StagePhases): string {
  const parts = [
    ['select', phases.selectMs],
    ['read', phases.readMs],
    ...phases.transforms.map(({ name, durationMs }) => [name, durationMs]),
    ['validate', phases.validateMs],
    ['project', phases.projectMs],
    ['write', phases.writeMs],
  ] as [string, number][];
  const spent = parts
    .filter(([, durationMs]) => durationMs > 0)
    .map(([name, durationMs]) => `${name} ${prettyMilliseconds(durationMs)}`);
  return spent.length === 0 ? '' : chalk.dim(` (busy: ${spent.join(', ')})`);
}

/** What a stage counted, as a dimmed suffix; nothing when it counted nothing. */
function countsSummary(counts: StageCompleteEvent['counts']): string {
  const entries = Object.entries(counts ?? {});
  return entries.length === 0
    ? ''
    : chalk.dim(
        ` (${entries.map(([name, count]) => `${name} ${compactNumber.format(count)}`).join(', ')})`,
      );
}

/** Longest example value printed in full; a literal where a date belongs can
 *  be a whole description. */
const MAX_EXAMPLE_LENGTH = 80;

function truncated(value: string): string {
  return value.length > MAX_EXAMPLE_LENGTH
    ? `${value.slice(0, MAX_EXAMPLE_LENGTH - 1)}…`
    : value;
}
