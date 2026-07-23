import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import { Distribution } from '@lde/dataset';
import { LastModifiedDownloader } from '../src/download.js';
import nock from 'nock';
import { join } from 'node:path';
import os from 'node:os';
import fs from 'node:fs/promises';
const localFile = join(os.tmpdir(), 'example.com!file.nt');
const downloader = new LastModifiedDownloader(os.tmpdir());
const distribution = new Distribution(
  new URL('https://example.com/file.nt'),
  'application/n-triples',
);

describe('LastModifiedDownloader', () => {
  afterAll(async () => {
    nock.restore();
  });

  describe('download', () => {
    beforeEach(async () => {
      // Reset distribution state between tests.
      distribution.lastModified = undefined;
      distribution.byteSize = undefined;

      try {
        await fs.unlink(localFile);
      } catch {
        // Ignore if not exists.
      }
    });

    it('downloads file', async () => {
      nock('https://example.com').get('/file.nt').reply(200, 'mock file');

      const result = await downloader.download(distribution);
      expect(result.path).toBe(localFile);

      const fileContent = await fs.readFile(localFile, 'utf8');
      expect(fileContent).toBe('mock file');
    });

    it('creates the target directory if it does not exist', async () => {
      const missingDir = join(os.tmpdir(), 'lde-download-test', 'nested');
      await fs.rm(join(os.tmpdir(), 'lde-download-test'), {
        recursive: true,
        force: true,
      });
      nock('https://example.com').get('/file.nt').reply(200, 'mock file');

      const missingDirDownloader = new LastModifiedDownloader(missingDir);
      const result = await missingDirDownloader.download(distribution);

      const fileContent = await fs.readFile(result.path, 'utf8');
      expect(fileContent).toBe('mock file');

      await fs.rm(join(os.tmpdir(), 'lde-download-test'), {
        recursive: true,
        force: true,
      });
    });

    it('does not download file again if it is up to date', async () => {
      nock('https://example.com')
        .get('/file.nt')
        .times(1)
        .reply(200, 'mock file');
      const { path: filePath } = await downloader.download(distribution);
      const stat = await fs.stat(filePath);

      distribution.lastModified = new Date('2001-01-01');
      await downloader.download(distribution);
      expect((await fs.stat(filePath)).mtime).toEqual(stat.mtime);
    });

    it('throws an error if file is unavailable', async () => {
      nock('https://example.com').get('/file.nt').reply(500);
      await expect(downloader.download(distribution)).rejects.toThrow(
        'Failed to download https://example.com/file.nt: Internal Server Error',
      );
    });

    it('throws an error if file is empty', async () => {
      nock('https://example.com').get('/file.nt').reply(200, '');
      await expect(downloader.download(distribution)).rejects.toThrow(
        'Distribution download is empty',
      );
    });

    it('re-downloads file if local file size does not match byteSize', async () => {
      // First download creates incomplete file.
      nock('https://example.com').get('/file.nt').reply(200, 'partial');
      await downloader.download(distribution);

      // Set distribution metadata indicating file should be larger.
      distribution.lastModified = new Date('2001-01-01');
      distribution.byteSize = 100;

      // Second download should re-fetch because size doesn't match.
      nock('https://example.com').get('/file.nt').reply(200, 'complete file');
      await downloader.download(distribution);

      const fileContent = await fs.readFile(localFile, 'utf8');
      expect(fileContent).toBe('complete file');
    });

    it('rejects a target that escapes the base directory', async () => {
      await expect(
        downloader.download(distribution, '../../etc/passwd'),
      ).rejects.toThrow(/escapes the base directory/);
    });

    it('logs debug messages when logger is provided', async () => {
      nock('https://example.com').get('/file.nt').reply(200, 'mock file');
      await downloader.download(distribution);

      distribution.lastModified = new Date('2001-01-01');
      const debugMessages: string[] = [];
      // eslint-disable-next-line @typescript-eslint/no-empty-function
      const noop = () => {};
      const logger = {
        fatal: noop,
        error: noop,
        warn: noop,
        info: noop,
        debug: (msg: string) => debugMessages.push(msg),
        trace: noop,
      };

      await downloader.download(distribution, undefined, { logger });
      expect(debugMessages.some((msg) => msg.includes('is up to date'))).toBe(
        true,
      );
    });
  });
});
