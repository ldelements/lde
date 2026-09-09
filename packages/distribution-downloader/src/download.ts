import { Distribution } from '@lde/dataset';
import filenamifyUrl from 'filenamify-url';
import { dirname, join, resolve, sep } from 'node:path';
import { Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { createWriteStream } from 'node:fs';
import { access, mkdir, rm, stat } from 'node:fs/promises';
export interface Logger {
  fatal(msg: string, ...args: unknown[]): void;
  error(msg: string, ...args: unknown[]): void;
  warn(msg: string, ...args: unknown[]): void;
  info(msg: string, ...args: unknown[]): void;
  debug(msg: string, ...args: unknown[]): void;
  trace(msg: string, ...args: unknown[]): void;
}

// eslint-disable-next-line @typescript-eslint/no-empty-function
const noop = () => {};
const noopLogger: Logger = {
  fatal: noop,
  error: noop,
  warn: noop,
  info: noop,
  debug: noop,
  trace: noop,
};

export interface DownloadOptions {
  logger?: Logger;
  /**
   * Idle timeout in milliseconds: the download is aborted when no bytes have
   * arrived for this long, whether while waiting for the response headers or
   * midway through the body. A large file that keeps flowing is never cut off,
   * however long it takes. Defaults to 300 000 ms (5 minutes).
   */
  timeout?: number;
  /**
   * Cancels the download when aborted; the partial file is removed.
   */
  signal?: AbortSignal;
}

export interface DownloadResult {
  path: string;
  headers: Headers;
}

export interface Downloader {
  download(
    distribution: Distribution,
    target?: string,
    options?: DownloadOptions,
  ): Promise<DownloadResult>;
}

export class LastModifiedDownloader implements Downloader {
  constructor(private readonly path = 'imports') {}

  public async download(
    distribution: Distribution,
    target = join(this.path, filenamifyUrl(distribution.accessUrl)),
    options?: DownloadOptions,
  ): Promise<DownloadResult> {
    const logger = options?.logger ?? noopLogger;
    const downloadUrl = distribution.accessUrl;
    const filePath = resolve(target);
    const baseDir = resolve(this.path);
    if (!filePath.startsWith(baseDir + sep)) {
      throw new Error(
        `Download target escapes the base directory: ${filePath}`,
      );
    }

    if (await this.localFileIsUpToDate(filePath, distribution)) {
      logger.debug(`File ${filePath} is up to date, skipping download.`);
      return { path: filePath, headers: new Headers() };
    }

    const idleTimeout = options?.timeout ?? 300_000;
    const idleAbortController = new AbortController();
    let idleTimer: NodeJS.Timeout | undefined;
    const restartIdleTimer = () => {
      clearTimeout(idleTimer);
      idleTimer = setTimeout(
        () =>
          idleAbortController.abort(
            new Error(`No data received for ${idleTimeout} ms`),
          ),
        idleTimeout,
      );
    };
    const signal =
      options?.signal === undefined
        ? idleAbortController.signal
        : AbortSignal.any([options.signal, idleAbortController.signal]);

    restartIdleTimer();
    try {
      const downloadResponse = await fetch(downloadUrl, { signal });
      if (!downloadResponse.ok || !downloadResponse.body) {
        throw new Error(
          `Failed to download ${downloadUrl}: ${downloadResponse.statusText}`,
        );
      }

      try {
        await mkdir(dirname(filePath), { recursive: true });
        await pipeline(
          downloadResponse.body,
          new Transform({
            transform(chunk, _encoding, callback) {
              restartIdleTimer();
              callback(null, chunk);
            },
          }),
          createWriteStream(filePath),
        );
      } catch (error) {
        await rm(filePath, { force: true });
        throw new Error(
          `Failed to save ${downloadUrl} to ${filePath}: ${error}`,
        );
      }

      const stats = await stat(filePath);
      if (stats.size <= 1) {
        logger.debug(`Distribution download ${downloadUrl} is empty`);
        throw new Error('Distribution download is empty');
      }

      return { path: filePath, headers: downloadResponse.headers };
    } finally {
      clearTimeout(idleTimer);
    }
  }

  private async localFileIsUpToDate(
    filePath: string,
    distribution: Distribution,
  ): Promise<boolean> {
    if (undefined === distribution.lastModified) {
      return false;
    }

    try {
      await access(filePath);
    } catch {
      return false;
    }
    const stats = await stat(filePath);

    // Check if file size matches expected size to detect incomplete downloads.
    if (
      distribution.byteSize !== undefined &&
      stats.size !== distribution.byteSize
    ) {
      return false;
    }

    return stats.mtime >= distribution.lastModified;
  }
}
