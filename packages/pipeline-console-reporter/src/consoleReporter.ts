import type { Dataset, Distribution } from '@lde/dataset';
import type {
  DistributionAnalysisResult,
  ProgressReporter,
  TimeoutTransitionEvent,
  ValidationReport,
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

export class ConsoleReporter implements ProgressReporter {
  private activeSpinner?: Ora;
  private stageStartTime = 0;
  private datasetStartTime = 0;
  private datasetTotal = 0;
  private datasetIndex = 0;
  private importTimer?: ReturnType<typeof setInterval>;
  private probeLines: { url: string; text: string }[] = [];

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

  pipelineStart(_name: string): void {
    this.startSpinner('Selecting datasets');
  }

  datasetsSelected(count: number, duration: number): void {
    this.datasetTotal = count;
    if (this.activeSpinner) {
      this.activeSpinner.text = `Selected datasets: found ${chalk.bold(count)} ${
        count === 1 ? 'dataset' : 'datasets'
      } in ${chalk.bold(prettyMilliseconds(duration))}`;
    }
  }

  datasetStart(dataset: Dataset): void {
    this.activeSpinner?.succeed();
    this.activeSpinner = undefined;
    this.clearImportTimer();
    this.datasetStartTime = Date.now();
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

  distributionProbed(result: DistributionAnalysisResult): void {
    const url = result.distribution.accessUrl.toString();
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

  importStarted(): void {
    const importStart = Date.now();
    const spinner = this.startSpinner('Importing\u2026', 1);
    this.importTimer = setInterval(() => {
      if (spinner.isSpinning) {
        spinner.suffixText = prettyMilliseconds(Date.now() - importStart);
      }
    }, 1_000);
  }

  importFailed(_distribution: Distribution, error: string): void {
    if (this.activeSpinner) {
      this.activeSpinner.text = `Import failed: ${error}`;
      this.activeSpinner.suffixText = '';
      this.activeSpinner.fail();
    } else {
      this.printLine(logSymbols.error, `Import failed: ${error}`, 1);
    }
    this.clearImportTimer();
    this.activeSpinner = undefined;
  }

  distributionSelected(
    _dataset: Dataset,
    distribution: Distribution,
    importedFrom?: Distribution,
    importDuration?: number,
    tripleCount?: number,
  ): void {
    if (importedFrom) {
      const count =
        tripleCount !== undefined
          ? `${compactNumber.format(tripleCount)} triples, `
          : '';
      const duration =
        importDuration !== undefined
          ? ` in ${chalk.bold(prettyMilliseconds(importDuration))}`
          : '';
      const text = `Imported ${importedFrom.accessUrl.toString()} (${count}to ${distribution.accessUrl.toString()})${duration}`;
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
      this.clearImportTimer(); // defensive — prevents leaks from a previous dataset
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

  stageStart(stage: string): void {
    this.stageStartTime = Date.now();
    this.startSpinner(`Stage ${chalk.bold(stage)}`, 1);
  }

  stageProgress(update: {
    itemsProcessed: number;
    quadsGenerated: number;
    memoryUsageBytes: number;
    heapUsedBytes: number;
  }): void {
    if (this.activeSpinner) {
      const elapsed = prettyMilliseconds(Date.now() - this.stageStartTime);
      this.activeSpinner.suffixText = `${compactNumber.format(
        update.itemsProcessed,
      )} items, ${compactNumber.format(
        update.quadsGenerated,
      )} quads, ${elapsed}, memory: ${formatBytes(update.memoryUsageBytes)} RSS, ${formatBytes(update.heapUsedBytes)} heap`;
    }
  }

  stageComplete(
    _stage: string,
    result: {
      itemsProcessed: number;
      quadsGenerated: number;
      duration: number;
    },
  ): void {
    if (this.activeSpinner) {
      const counts =
        result.itemsProcessed > 0
          ? ` ${compactNumber.format(result.itemsProcessed)} items, ${compactNumber.format(result.quadsGenerated)} quads,`
          : '';
      this.activeSpinner.suffixText = '';
      this.activeSpinner.text = `${this.activeSpinner.text}${counts} took ${chalk.bold(
        prettyMilliseconds(result.duration),
      )}`;
      this.activeSpinner.succeed();
      this.activeSpinner = undefined;
    }
  }

  stageFailed(_stage: string, error: Error): void {
    if (this.activeSpinner) {
      this.activeSpinner.suffixText = chalk.red(error.message);
      this.activeSpinner.fail();
      this.activeSpinner = undefined;
    }
  }

  datasetValidated(_dataset: Dataset, report: ValidationReport): void {
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

  stageSkipped(_stage: string, reason: string): void {
    if (this.activeSpinner) {
      this.activeSpinner.suffixText = `skipped: ${chalk.red(reason)}`;
      this.activeSpinner.fail();
      this.activeSpinner = undefined;
    }
  }

  datasetComplete(
    _dataset: Dataset,
    result: { memoryUsageBytes: number; heapUsedBytes: number },
  ): void {
    this.printLine(
      logSymbols.success,
      `Completed in ${chalk.bold(
        prettyMilliseconds(Date.now() - this.datasetStartTime),
      )} ${chalk.dim(`(memory: ${formatBytes(result.memoryUsageBytes)} RSS, ${formatBytes(result.heapUsedBytes)} heap)`)}`,
      1,
    );
  }

  datasetSkipped(_dataset: Dataset, reason: string): void {
    this.printLine(logSymbols.error, `Skipped: ${chalk.red(reason)}`, 1);
  }

  pipelineComplete(result: {
    duration: number;
    memoryUsageBytes: number;
    heapUsedBytes: number;
  }): void {
    process.stderr.write(
      `\nPipeline completed in ${chalk.bold(
        prettyMilliseconds(result.duration),
      )} ${chalk.dim(`(memory: ${formatBytes(result.memoryUsageBytes)} RSS, ${formatBytes(result.heapUsedBytes)} heap)`)}\n`,
    );
  }

  timeoutTightened(event: TimeoutTransitionEvent): void {
    this.printLine(
      chalk.yellow('↘'),
      `Tightened timeout for ${event.endpoint.toString()} to ${chalk.bold(
        prettyMilliseconds(event.toTimeoutMs),
      )} after ${chalk.bold(event.consecutiveTimeouts)} consecutive timeouts`,
      2,
    );
  }

  timeoutRelaxed(event: TimeoutTransitionEvent): void {
    this.printLine(
      chalk.green('↗'),
      `Relaxed timeout for ${event.endpoint.toString()} back to ${chalk.bold(
        prettyMilliseconds(event.toTimeoutMs),
      )} after successful request`,
      2,
    );
  }
}
