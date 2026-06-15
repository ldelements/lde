import {
  Importer as ImporterInterface,
  ImporterOptions,
  ImportFailed,
  ImportSuccessful,
  NotSupported,
} from '@lde/sparql-importer';
import { compressionMediaTypes, Distribution } from '@lde/dataset';
import { LastModifiedDownloader } from '@lde/distribution-downloader';
import { basename, dirname, join } from 'path';
import { readFile, stat, writeFile } from 'node:fs/promises';
import { needsPreprocessing, preprocess } from './preprocess.js';

export interface QleverIndexOptions {
  /** @default true */
  'ascii-prefixes-only'?: boolean;
  /** @default 3_000_000 */
  'num-triples-per-batch'?: number;
  /** Memory budget for sorting during the index build. @default '10G' */
  'stxxl-memory'?: string;
  /** @default true */
  'parse-parallel'?: boolean;
  /** Build only PSO and POS permutations. Faster, but queries with predicate variables won't work. Also disables pattern precomputation. @default false */
  'only-pso-and-pos-permutations'?: boolean;
}

export interface QleverImporterOptions extends ImporterOptions {
  /** @default 'data' */
  indexName?: string;
  qleverOptions?: QleverIndexOptions;
}

/**
 * Import RDF to a QLever SPARQL server.
 *
 * - Use the QLever CLI because the Graph Store Protocol is not parallelized.
 */
type ResolvedOptions = Required<QleverImporterOptions> & {
  qleverOptions: Required<QleverIndexOptions>;
};

export class Importer implements ImporterInterface {
  private readonly options: ResolvedOptions;

  constructor(options: QleverImporterOptions) {
    this.options = {
      ...options,
      indexName: options.indexName ?? 'data',
      downloader: options.downloader ?? new LastModifiedDownloader(),
      cacheIndex: options.cacheIndex ?? true,
      qleverOptions: {
        ...defaultQleverIndexOptions,
        ...options.qleverOptions,
      },
    };
  }

  public async import(
    distributions: Distribution[],
  ): Promise<NotSupported | ImportSuccessful | ImportFailed> {
    const downloadDistributions = distributions
      .filter(
        (distribution): distribution is Distribution & { mimeType: string } =>
          distribution.mimeType !== undefined &&
          acceptedMediaTypes.includes(distribution.mimeType),
      )
      .sort(
        (a, b) =>
          acceptedMediaTypes.indexOf(a.mimeType) -
          acceptedMediaTypes.indexOf(b.mimeType),
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
    const { path: localFile, headers } =
      await this.options.downloader.download(distribution);

    if (await this.isIndexUpToDate(localFile)) {
      const tripleCount = await this.readTripleCount(localFile);
      if (tripleCount === 0) {
        return new ImportFailed(
          distribution,
          'Index is cached but contains 0 triples',
        );
      }
      return new ImportSuccessful(distribution, undefined, tripleCount);
    }

    let indexFile = localFile;
    let format: fileFormat;
    const warnings: string[] = [];
    if (needsPreprocessing(distribution)) {
      const result = await preprocess(localFile, distribution);
      indexFile = result.path;
      format = result.format;
      warnings.push(...result.warnings);
    } else {
      const resolved = fileFormatFor(
        distribution.mimeType,
        basename(localFile),
        headers.get('Content-Type') ?? undefined,
      );
      format = resolved.format;
      if (resolved.warning) warnings.push(resolved.warning);
    }
    let logs: string;
    try {
      logs = await this.index(indexFile, format);
    } catch (error) {
      if (
        format === 'ttl' &&
        (error as Error).message?.includes('multiline string literal')
      ) {
        logs = await this.index(indexFile, format, false);
      } else {
        throw error;
      }
    }
    const tripleCount = this.parseTripleCount(logs);

    if (tripleCount === 0) {
      return new ImportFailed(
        distribution,
        'Indexed 0 triples from distribution',
      );
    }

    await this.writeCacheInfo(localFile);

    return new ImportSuccessful(distribution, undefined, tripleCount, warnings);
  }

  private parseTripleCount(logs: string): number | undefined {
    // Extract num-triples.normal from the metadata JSON that the index
    // command cats to stdout. Use a regex rather than JSON.parse because
    // Docker log multiplexing prepends binary frame headers to each chunk.
    const match = logs.match(/"num-triples":\{[^}]*"normal":(\d+)/);
    return match ? Number(match[1]) : undefined;
  }

  private cacheInfoPath(dataFile: string): string {
    return join(dirname(dataFile), `${this.options.indexName}.cache-info.json`);
  }

  /**
   * Check whether the cached index is still up to date.
   */
  private async isIndexUpToDate(dataFile: string): Promise<boolean> {
    if (!this.options.cacheIndex) return false;

    let cacheInfo: CacheInfo;
    try {
      const raw = await readFile(this.cacheInfoPath(dataFile), 'utf-8');
      cacheInfo = JSON.parse(raw) as CacheInfo;
    } catch {
      return false; // No cache marker — first run.
    }

    if (cacheInfo.sourceFile !== basename(dataFile)) {
      return false; // Different dataset was last indexed.
    }

    const [cacheInfoStat, dataFileStat] = await Promise.all([
      stat(this.cacheInfoPath(dataFile)),
      stat(dataFile),
    ]);
    if (dataFileStat.mtimeMs > cacheInfoStat.mtimeMs) {
      return false; // Data was re-downloaded.
    }

    return true;
  }

  /** Read the triple count from QLever's metadata file. */
  private async readTripleCount(dataFile: string): Promise<number | undefined> {
    try {
      const metadataPath = join(
        dirname(dataFile),
        `${this.options.indexName}.meta-data.json`,
      );
      const raw = await readFile(metadataPath, 'utf-8');
      return this.parseTripleCount(raw);
    } catch {
      return undefined;
    }
  }

  private async writeCacheInfo(dataFile: string): Promise<void> {
    const info: CacheInfo = { sourceFile: basename(dataFile) };
    await writeFile(this.cacheInfoPath(dataFile), JSON.stringify(info));
  }

  private async index(
    file: string,
    format: fileFormat,
    parseParallel?: boolean,
  ): Promise<string> {
    const settingsFile = 'index.settings.json';
    const settings = {
      'ascii-prefixes-only': this.options.qleverOptions['ascii-prefixes-only'],
      'num-triples-per-batch':
        this.options.qleverOptions['num-triples-per-batch'],
    };
    await writeFile(
      `${dirname(file)}/${settingsFile}`,
      JSON.stringify(settings),
    );

    // TODO: write index to named volume instead of bind mount for better performance.

    const parallel =
      parseParallel ?? this.options.qleverOptions['parse-parallel'];
    const flags = [
      `-i ${this.options.indexName}`,
      `-s ${settingsFile}`,
      `-F ${format}`,
      `--parse-parallel ${parallel}`,
      `-m ${this.options.qleverOptions['stxxl-memory']}`,
      this.options.qleverOptions['only-pso-and-pos-permutations']
        ? '-o --no-patterns'
        : '',
      '-f -',
    ]
      .filter(Boolean)
      .join(' ');

    const metadataFile = `${this.options.indexName}.meta-data.json`;
    const localName = basename(file);
    const decompressCommand = localName.toLowerCase().endsWith('.zip')
      ? `unzip -p ${shellQuote(localName)}`
      : `(gunzip -c ${shellQuote(localName)} 2>/dev/null || cat ${shellQuote(localName)})`;
    const indexTask = await this.options.taskRunner.run(
      `${decompressCommand} | qlever-index ${flags} && cat ${shellQuote(metadataFile)}`,
    );
    return await this.options.taskRunner.wait(indexTask);
  }
}

/**
 * POSIX-quote a value for safe interpolation into a shell command: wrap it in
 * single quotes and escape any embedded single quote as `'\''`.
 *
 * Without this, a data filename containing an apostrophe — e.g. a dataset
 * titled `'s-Hertogenbosch`, whose distribution URL maps to a local file like
 * `…Erfgoed+'s-Hertogenbosch.nt` — would terminate the surrounding quotes, so
 * `cat`/`gunzip` would read a non-existent path and feed `qlever-index` empty
 * input. The index then "succeeds" with 0 triples, the import is treated as
 * failed, and every distribution (and the JSON-LD fallback) fails the same way.
 */
function shellQuote(value: string): string {
  return `'${value.replace(/'/g, "'\\''")}'`;
}

type fileFormat = 'nt' | 'nq' | 'ttl';

/**
 * Native QLever index formats — `qlever-index -F <flag>` consumes these
 * directly. JSON-LD is not here: it is preprocessed to N-Quads first (see
 * {@link preprocess}).
 */
const nativeFormats = new Map<string, fileFormat>([
  ['application/n-triples', 'nt'],
  ['application/n-quads', 'nq'],
  ['text/turtle', 'ttl'],
]);

/**
 * Accepted distribution media types, in preference order: the first match is
 * tried first. Native formats win over JSON-LD, RDF/XML and TriG because they
 * skip the Node-side preprocessor; TriG comes last so a streaming native dump
 * is always preferred when a dataset offers both.
 *
 * `application/zip` is intentionally absent — the inner RDF format must be
 * declared via `mediaType` with `application/zip` appearing only as the
 * `compressFormat`, so we know what is inside.
 */
const acceptedMediaTypes: readonly string[] = [
  'application/n-quads',
  'application/n-triples',
  'text/turtle',
  'application/ld+json',
  'application/rdf+xml',
  'application/trig',
];

const defaultQleverIndexOptions = {
  'ascii-prefixes-only': true,
  'num-triples-per-batch': 3_000_000,
  'stxxl-memory': '10G',
  'parse-parallel': true,
  'only-pso-and-pos-permutations': false,
} satisfies Required<QleverIndexOptions>;

interface CacheInfo {
  sourceFile: string;
}

const extensionFormats = new Map<string, fileFormat>([
  ['.nt', 'nt'],
  ['.nq', 'nq'],
  ['.ttl', 'ttl'],
]);

interface ResolvedFormat {
  format: fileFormat;
  warning?: string;
}

/**
 * Determine the QLever format flag for a distribution.
 *
 * Priority:
 * 1. Server Content-Type (if it maps to a supported RDF format)
 * 2. File extension (fallback when Content-Type is a compression type or missing)
 * 3. Declared MIME type from the dataset registry (last resort)
 */
function fileFormatFor(
  declaredMimeType: string,
  filename: string,
  serverContentType?: string,
): ResolvedFormat {
  const declaredFormat = nativeFormats.get(declaredMimeType);
  if (declaredFormat === undefined) {
    throw new Error(`Unsupported media type: ${declaredMimeType}`);
  }

  // Try server Content-Type first (strip parameters like "; charset=utf-8").
  if (serverContentType) {
    const actualType = serverContentType.split(';')[0].trim();
    if (!compressionMediaTypes.has(actualType)) {
      const serverFormat = nativeFormats.get(actualType);
      if (serverFormat !== undefined && serverFormat !== declaredFormat) {
        return {
          format: serverFormat,
          warning: `Server Content-Type ${actualType} does not match declared media type ${declaredMimeType}; using ${serverFormat} format`,
        };
      }
      if (serverFormat !== undefined) {
        return { format: serverFormat };
      }
    }
  }

  // Fall back to file extension.
  const stripped = filename.replace(/\.(gz|bz2|xz|zst)$/i, '');
  const extension = stripped.slice(stripped.lastIndexOf('.'));
  const extensionFormat = extensionFormats.get(extension);

  if (extensionFormat !== undefined && extensionFormat !== declaredFormat) {
    return {
      format: extensionFormat,
      warning: `Declared media type ${declaredMimeType} does not match file extension ${extension}; using ${extensionFormat} format`,
    };
  }

  return { format: declaredFormat };
}
