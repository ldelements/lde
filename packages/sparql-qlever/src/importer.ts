import {
  Importer as ImporterInterface,
  ImportFailed,
  ImportSuccessful,
  NotSupported,
} from '@lde/sparql-importer';
import { Dataset, Distribution } from '@lde/dataset';
import {
  Downloader,
  LastModifiedDownloader,
} from '@lde/distribution-downloader';
import { basename, dirname } from 'path';
import { writeFile } from 'node:fs/promises';
import { TaskRunner } from '@lde/task-runner';

type fileFormat = 'nt' | 'nq' | 'ttl';

const supportedFormats = new Map<string, fileFormat>([
  ['application/n-triples', 'nt'],
  ['application/n-quads', 'nq'],
  ['text/turtle', 'ttl'],
]);

export interface Options {
  taskRunner: TaskRunner<unknown>;
  indexName?: string;
  downloader?: Downloader;
  qleverOptions?: {
    'ascii-prefixes-only': boolean;
    'num-triples-per-batch': number;
  };
  port?: number;
}

/**
 * Import RDF to a QLever SPARQL server.
 *
 * - Use the QLever CLI because the Graph Store Protocol is not parallelized.
 */
export class Importer implements ImporterInterface {
  private indexName;
  private taskRunner: TaskRunner<unknown>;
  private downloader;
  private qleverOptions;

  constructor({ taskRunner, downloader, indexName, qleverOptions }: Options) {
    this.taskRunner = taskRunner;
    this.downloader = downloader ?? new LastModifiedDownloader();
    this.indexName = indexName ?? 'data';
    this.qleverOptions = qleverOptions ?? {
      'ascii-prefixes-only': true,
      'num-triples-per-batch': 100000,
    };
  }

  public async import(
    dataset: Dataset,
  ): Promise<NotSupported | ImportSuccessful | ImportFailed> {
    const downloadDistributions = dataset
      .getDownloadDistributions()
      .filter(
        (distribution): distribution is Distribution & { mimeType: string } =>
          distribution.mimeType !== undefined &&
          supportedFormats.has(distribution.mimeType),
      );
    if (downloadDistributions.length === 0) {
      return new NotSupported();
    }

    let result!: ImportSuccessful | ImportFailed;
    for (const downloadDistribution of downloadDistributions) {
      try {
        result = await this.doImport(downloadDistribution);
        if (result instanceof ImportSuccessful) {
          return result;
        }
      } catch (error) {
        let errorMessage;
        if (error instanceof AggregateError) {
          errorMessage = error.errors.join(' / ');
        } else {
          errorMessage = (error as Error).message;
        }
        result = new ImportFailed(downloadDistribution, errorMessage);
      }
    }

    return result;
  }

  private async doImport(
    distribution: Distribution & { mimeType: string },
  ): Promise<ImportSuccessful | ImportFailed> {
    const localFile = await this.downloader.download(distribution);
    const logs = await this.index(
      localFile,
      this.fileFormatFromMimeType(distribution.mimeType),
    );
    const tripleCount = this.parseTripleCount(logs);

    return new ImportSuccessful(distribution, undefined, tripleCount);
  }

  private fileFormatFromMimeType(mimeType: string): fileFormat {
    const format = supportedFormats.get(mimeType);
    if (format === undefined) {
      throw new Error(`Unsupported media type: ${mimeType}`);
    }
    return format;
  }

  private parseTripleCount(logs: string): number | undefined {
    // Extract num-triples.normal from the metadata JSON that the index
    // command cats to stdout. Use a regex rather than JSON.parse because
    // Docker log multiplexing prepends binary frame headers to each chunk.
    const match = logs.match(/"num-triples":\{[^}]*"normal":(\d+)/);
    return match ? Number(match[1]) : undefined;
  }

  private async index(file: string, format: fileFormat): Promise<string> {
    const workingDir = dirname(file);
    const settingsFile = 'index.settings.json';
    // Turtle is not line-delimited, so QLever's parallel parser can't split
    // the input into independent chunks. Disable it to avoid parse failures.
    const settings =
      format === 'ttl'
        ? { ...this.qleverOptions, 'parallel-parsing': false }
        : this.qleverOptions;
    await writeFile(`${workingDir}/${settingsFile}`, JSON.stringify(settings));

    // TODO: write index to named volume instead of bind mount for better performance.

    const metadataFile = `${this.indexName}.meta-data.json`;
    const indexTask = await this.taskRunner.run(
      `(zcat '${basename(file)}' 2>/dev/null || cat '${basename(
        file,
      )}') | qlever-index -i ${
        this.indexName
      } -s ${settingsFile} -F ${format} -f - && cat ${metadataFile}`,
    );
    return await this.taskRunner.wait(indexTask);
  }
}
