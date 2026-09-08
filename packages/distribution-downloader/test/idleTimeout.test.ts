import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { Distribution } from '@lde/dataset';
import { LastModifiedDownloader } from '../src/download.js';
import { createServer, Server, ServerResponse } from 'node:http';
import { AddressInfo } from 'node:net';
import { join } from 'node:path';
import os from 'node:os';
import fs from 'node:fs/promises';

// Runs against a real local HTTP server rather than nock, whose fetch
// interceptor buffers the whole response and so hides the chunk timing.
const downloader = new LastModifiedDownloader(os.tmpdir());

describe('LastModifiedDownloader idle timeout', () => {
  let server: Server;
  let pendingResponses: ServerResponse[];
  let serverFile: string;
  const serverDistribution = (path: string) =>
    new Distribution(
      new URL(
        path,
        `http://localhost:${(server.address() as AddressInfo).port}`,
      ),
      'application/n-triples',
    );

  beforeEach(async () => {
    pendingResponses = [];
    server = createServer((request, response) => {
      pendingResponses.push(response);
      response.writeHead(200);
      if (request.url === '/trickle') {
        // Twenty chunks 50 ms apart: 1 s in total, never idle for long. The
        // margins are wide because CI runners run many test suites at once.
        let chunksSent = 0;
        const interval = setInterval(() => {
          response.write('chunk ');
          if (++chunksSent === 20) {
            clearInterval(interval);
            response.end();
          }
        }, 50);
      } else {
        // One chunk, then silence.
        response.write('partial');
      }
    });
    await new Promise<void>((resolve) => server.listen(0, resolve));
    const { port } = server.address() as AddressInfo;
    serverFile = join(os.tmpdir(), `lde-idle-timeout-${port}`);
  });

  afterEach(async () => {
    for (const response of pendingResponses) {
      response.destroy();
    }
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await fs.rm(serverFile, { force: true });
  });

  it('completes a slow download whose total time exceeds the timeout', async () => {
    await downloader.download(serverDistribution('/trickle'), serverFile, {
      timeout: 500,
    });

    expect(await fs.readFile(serverFile, 'utf8')).toBe('chunk '.repeat(20));
  });

  it('aborts a stalled download and removes the partial file', async () => {
    await expect(
      downloader.download(serverDistribution('/stall'), serverFile, {
        timeout: 100,
      }),
    ).rejects.toThrow('No data received for 100 ms');

    await expect(fs.access(serverFile)).rejects.toThrow();
  });

  it('cancels the download when the caller aborts the signal', async () => {
    const abortController = new AbortController();
    setTimeout(() => abortController.abort(new Error('Cancelled')), 20);

    await expect(
      downloader.download(serverDistribution('/stall'), serverFile, {
        signal: abortController.signal,
      }),
    ).rejects.toThrow('Cancelled');

    await expect(fs.access(serverFile)).rejects.toThrow();
  });
});
