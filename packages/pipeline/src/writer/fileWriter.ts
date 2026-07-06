import { Dataset } from '@lde/dataset';
import type { Quad } from '@rdfjs/types';
import { createWriteStream, type WriteStream } from 'node:fs';
import { mkdir, rename, rm } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import filenamifyUrl from 'filenamify-url';
import { DataFactory, Writer as N3Writer } from 'n3';
import { DatasetOutcome, RunContext, RunWriter, Writer } from './writer.js';

export interface FileWriterOptions {
  /**
   * Output directory for written files.
   */
  outputDir: string;
  /**
   * File format to write.
   * @default 'n-triples'
   */
  format?: 'turtle' | 'n-triples' | 'n-quads';
  /**
   * Character used to replace URL-unsafe characters in filenames.
   * @default '-'
   */
  replacementCharacter?: string;
  /**
   * Turtle prefix declarations. Keys are prefix names, values are namespace IRIs.
   * Only used when format is 'turtle'.
   */
  prefixes?: Record<string, string>;
  /**
   * Derive the named-graph IRI each quad is written into. Only meaningful for
   * format `'n-quads'`; ignored for `'turtle'` and `'n-triples'`, which have no
   * graph slot. When set, every quad is re-emitted with this graph term,
   * regardless of the quad's own graph — mirroring
   * {@link SparqlUpdateWriter}'s `graphIri`, so the same callback produces the
   * same named-graph structure whether you write to a SPARQL store or to files.
   * Defaults to undefined (quads written as-is, i.e. the default graph).
   */
  graphIri?: (dataset: Dataset) => URL;
}

const formatMap: Record<string, string> = {
  turtle: 'Turtle',
  'n-triples': 'N-Triples',
  'n-quads': 'N-Quads',
};

/** An open per-dataset output file within one run. */
interface OpenFile {
  n3Writer: N3Writer;
  stream: WriteStream;
  tempPath: string;
  finalPath: string;
}

/**
 * The run writer a {@link FileWriter} opens: per-dataset `flush` and `reset`
 * are always available, so direct callers need no optional chaining. The
 * dataset outcome does not change what a flush does here – a failed dataset's
 * partial output still materializes, matching the pre-transactional behaviour.
 */
export interface FileRunWriter extends RunWriter {
  flush(dataset: Dataset, outcome?: DatasetOutcome): Promise<void>;
  reset(dataset: Dataset): Promise<void>;
}

/**
 * Streams RDF quads to files on disk using N3 Writer.
 *
 * Files are named based on the dataset IRI using filenamify-url.
 *
 * Within a run ({@link openRun}), a single N3Writer is kept open per dataset
 * across all `write` calls, so Turtle prefix declarations are written once and
 * triples can be grouped by subject. `flush` finalizes a dataset's file;
 * `commit` finalizes any files still open, and `abort` discards their
 * temporary output, leaving no half-written final file behind.
 */
export class FileWriter implements Writer {
  private readonly outputDir: string;
  readonly format: 'turtle' | 'n-triples' | 'n-quads';
  private readonly replacementCharacter: string;
  private readonly prefixes?: Record<string, string>;
  private readonly graphIri?: (dataset: Dataset) => URL;

  constructor(options: FileWriterOptions) {
    this.outputDir = options.outputDir;
    this.format = options.format ?? 'n-triples';
    this.replacementCharacter = options.replacementCharacter ?? '-';
    this.prefixes = options.prefixes;
    this.graphIri = options.graphIri;
  }

  async openRun(_context?: RunContext): Promise<FileRunWriter> {
    const openFiles = new Map<string, OpenFile>();
    return {
      write: (dataset, quads) => this.writeQuads(openFiles, dataset, quads),
      flush: (dataset) => this.flushFile(openFiles, dataset),
      reset: (dataset) => this.discardFile(openFiles, dataset),
      commit: async () => {
        // Finalize files not yet flushed per dataset – a safety net so a
        // committed run never leaves a complete output stuck in a temp file.
        for (const { finalPath } of openFiles.values()) {
          await this.flushPath(openFiles, finalPath);
        }
      },
      abort: async () => {
        // Discard all temp output: a crash or abort leaves at most a stale
        // `*.tmp`, never a truncated final file.
        for (const openFile of openFiles.values()) {
          await this.closeAndRemove(openFile);
        }
        openFiles.clear();
      },
    };
  }

  private async writeQuads(
    openFiles: Map<string, OpenFile>,
    dataset: Dataset,
    quads: AsyncIterable<Quad>,
  ): Promise<void> {
    // Peek at the first quad to avoid creating empty files.
    const iterator = quads[Symbol.asyncIterator]();
    const first = await iterator.next();
    if (first.done) return;

    const { n3Writer } = await this.getOrCreateFile(openFiles, dataset);

    // Re-emit each quad into the configured named graph (n-quads only). The
    // pipeline's quads carry no graph context, so the graph is supplied here
    // exactly as SparqlUpdateWriter supplies it via INSERT DATA { GRAPH … }.
    const graphNode =
      this.format === 'n-quads' && this.graphIri
        ? DataFactory.namedNode(this.graphIri(dataset).toString())
        : undefined;
    const addQuad = (quad: Quad) =>
      n3Writer.addQuad(
        graphNode
          ? DataFactory.quad(
              quad.subject,
              quad.predicate,
              quad.object,
              graphNode,
            )
          : quad,
      );

    addQuad(first.value);
    for await (const quad of { [Symbol.asyncIterator]: () => iterator }) {
      addQuad(quad);
    }
  }

  private async flushFile(
    openFiles: Map<string, OpenFile>,
    dataset: Dataset,
  ): Promise<void> {
    await this.flushPath(openFiles, this.getFilePath(dataset));
  }

  private async flushPath(
    openFiles: Map<string, OpenFile>,
    finalPath: string,
  ): Promise<void> {
    const openFile = openFiles.get(finalPath);
    if (!openFile) return;

    openFiles.delete(finalPath);

    // Quads are streamed to a sibling temp file; only on a clean flush is it
    // atomically renamed onto the final path. A crash therefore leaves at most
    // a stale `*.tmp` — never a truncated final file — so a downstream index
    // rebuild that globs the final extension never reads a half-written file.
    try {
      await new Promise<void>((resolve, reject) => {
        if (openFile.stream.errored) {
          reject(openFile.stream.errored);
          return;
        }
        openFile.n3Writer.end((error) => {
          if (error) reject(error);
          else resolve();
        });
      });
    } catch (error) {
      await rm(openFile.tempPath, { force: true, recursive: true });
      throw error;
    }

    await rename(openFile.tempPath, finalPath);
  }

  private async discardFile(
    openFiles: Map<string, OpenFile>,
    dataset: Dataset,
  ): Promise<void> {
    const key = this.getFilePath(dataset);
    const openFile = openFiles.get(key);
    if (!openFile) return;

    // Drop the open writer and remove its temp file so the next write starts a
    // fresh file, discarding everything streamed during the previous pass.
    openFiles.delete(key);
    await this.closeAndRemove(openFile);
  }

  /**
   * Close an open file's stream and remove its temp file. Await the stream
   * closing before removing: the write stream opens its fd lazily, so a
   * pending open could otherwise recreate the file after rm() ran.
   */
  private async closeAndRemove(openFile: OpenFile): Promise<void> {
    await new Promise<void>((resolve) => {
      openFile.stream.once('close', resolve);
      openFile.stream.destroy();
    });
    await rm(openFile.tempPath, { force: true, recursive: true });
  }

  getOutputPath(dataset: Dataset): string {
    return this.getFilePath(dataset);
  }

  getFilename(dataset: Dataset): string {
    const extension = this.getExtension();
    const baseName = filenamifyUrl(dataset.iri.toString(), {
      replacement: this.replacementCharacter,
    });
    return `${baseName}.${extension}`;
  }

  private getFilePath(dataset: Dataset): string {
    return join(this.outputDir, this.getFilename(dataset));
  }

  private async getOrCreateFile(
    openFiles: Map<string, OpenFile>,
    dataset: Dataset,
  ): Promise<OpenFile> {
    const finalPath = this.getFilePath(dataset);
    const existing = openFiles.get(finalPath);
    if (existing) return existing;

    await mkdir(dirname(finalPath), { recursive: true });

    // Write to a sibling temp file (same directory, so the flush rename stays on
    // one filesystem and is atomic). The `.tmp` suffix keeps it out of any glob
    // on the final extension.
    const tempPath = `${finalPath}.tmp`;
    const stream = createWriteStream(tempPath, { flags: 'w' });
    stream.on('error', (error) => {
      // Surface stream errors when flushing; prevents 'unhandled error' crashes.
      stream.destroy(error);
    });
    const n3Writer = new N3Writer(stream, {
      format: formatMap[this.format],
      prefixes: this.prefixes,
    });

    const openFile = { n3Writer, stream, tempPath, finalPath };
    openFiles.set(finalPath, openFile);
    return openFile;
  }

  private getExtension(): string {
    switch (this.format) {
      case 'turtle':
        return 'ttl';
      case 'n-triples':
        return 'nt';
      case 'n-quads':
        return 'nq';
    }
  }
}
