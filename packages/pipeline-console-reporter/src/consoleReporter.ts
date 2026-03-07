import type { Dataset, Distribution } from '@lde/dataset';
import type {
  DistributionAnalysisResult,
  ProgressReporter,
} from '@lde/pipeline';
import chalk from 'chalk';
import ora, { type Ora } from 'ora';
import prettyMilliseconds from 'pretty-ms';

const compactNumber = new Intl.NumberFormat('en', {
  notation: 'compact',
  maximumFractionDigits: 1,
});

export class ConsoleReporter implements ProgressReporter {
  private stageSpinner?: Ora;
  private stageStartTime = 0;
  private datasetStartTime = 0;
  private datasetTotal = 0;
  private datasetIndex = 0;

  pipelineStart(_name: string): void {
    this.stageSpinner = ora({
      discardStdin: false,
      text: 'Selecting datasets',
    }).start();
  }

  datasetsSelected(count: number, duration: number): void {
    this.datasetTotal = count;
    if (this.stageSpinner) {
      this.stageSpinner.text = `Selected datasets: found ${chalk.bold(count)} ${
        count === 1 ? 'dataset' : 'datasets'
      } in ${chalk.bold(prettyMilliseconds(duration))}`;
    }
  }

  datasetStart(dataset: Dataset): void {
    this.stageSpinner?.succeed();
    this.stageSpinner = undefined;
    this.datasetStartTime = Date.now();
    this.datasetIndex++;
    const counter =
      this.datasetTotal > 1
        ? ` ${chalk.dim(`[${this.datasetIndex}/${this.datasetTotal}]`)}`
        : '';
    console.info();
    console.info(`Dataset ${chalk.bold(dataset.iri.toString())}${counter}`);
  }

  distributionProbed(result: DistributionAnalysisResult): void {
    const url = result.distribution.accessUrl.toString();
    const typeLabel =
      result.type === 'sparql'
        ? 'SPARQL endpoint'
        : result.type === 'data-dump'
          ? 'Data dump'
          : 'Network error';

    const s = ora({ discardStdin: false });
    if (result.available) {
      const detail =
        result.statusCode !== undefined ? ` (HTTP ${result.statusCode})` : '';
      s.start(`${typeLabel} ${url}${detail}`);
      s.succeed();
    } else {
      const detail = result.error
        ? ` (${result.error})`
        : result.statusCode !== undefined
          ? ` (HTTP ${result.statusCode})`
          : '';
      s.start(`${typeLabel} ${url}${detail}`);
      s.fail();
    }
  }

  importFailed(_distribution: Distribution, error: string): void {
    const s = ora({ discardStdin: false });
    s.start(`Import failed: ${error}`);
    s.fail();
  }

  distributionSelected(
    _dataset: Dataset,
    distribution: Distribution,
    importedFrom?: Distribution,
    importDuration?: number,
    tripleCount?: number,
  ): void {
    const s = ora({ discardStdin: false });
    if (importedFrom) {
      const count =
        tripleCount !== undefined
          ? `${compactNumber.format(tripleCount)} triples, `
          : '';
      const duration =
        importDuration !== undefined
          ? ` in ${chalk.bold(prettyMilliseconds(importDuration))}`
          : '';
      s.start(
        `Imported ${importedFrom.accessUrl.toString()} (${count}to ${distribution.accessUrl.toString()})${duration}`,
      );
    } else {
      s.start(
        `${distribution.accessUrl.toString()} ${chalk.dim('(selected)')}`,
      );
    }
    s.succeed();
  }

  stageStart(stage: string): void {
    this.stageStartTime = Date.now();
    this.stageSpinner = ora({ discardStdin: false }).start();
    this.stageSpinner.text = `Stage ${chalk.bold(stage)}`;
  }

  stageProgress(update: {
    itemsProcessed: number;
    quadsGenerated: number;
  }): void {
    if (this.stageSpinner) {
      const elapsed = prettyMilliseconds(Date.now() - this.stageStartTime);
      this.stageSpinner.suffixText = `${compactNumber.format(
        update.itemsProcessed,
      )} items, ${compactNumber.format(
        update.quadsGenerated,
      )} quads, ${elapsed}`;
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
    if (this.stageSpinner) {
      this.stageSpinner.suffixText = `took ${chalk.bold(
        prettyMilliseconds(result.duration),
      )}`;
      this.stageSpinner.succeed();
      this.stageSpinner = undefined;
    }
  }

  stageFailed(_stage: string, error: Error): void {
    if (this.stageSpinner) {
      this.stageSpinner.suffixText = chalk.red(error.message);
      this.stageSpinner.fail();
      this.stageSpinner = undefined;
    }
  }

  stageSkipped(_stage: string, reason: string): void {
    if (this.stageSpinner) {
      this.stageSpinner.suffixText = `skipped: ${chalk.red(reason)}`;
      this.stageSpinner.fail();
      this.stageSpinner = undefined;
    }
  }

  datasetComplete(_dataset: Dataset): void {
    const s = ora({
      discardStdin: false,
      text: `Completed in ${chalk.bold(
        prettyMilliseconds(Date.now() - this.datasetStartTime),
      )}`,
    }).start();
    s.succeed();
  }

  datasetSkipped(_dataset: Dataset, reason: string): void {
    const s = ora({
      discardStdin: false,
      text: `Skipped: ${chalk.red(reason)}`,
    }).start();
    s.fail();
  }

  pipelineComplete(result: { duration: number }): void {
    console.info(
      `\nPipeline completed in ${chalk.bold(
        prettyMilliseconds(result.duration),
      )}`,
    );
  }
}
