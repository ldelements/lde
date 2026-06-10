import { Dataset } from '@lde/dataset';
import type { Quad } from '@rdfjs/types';
import { createWriteStream, type WriteStream } from 'node:fs';
import { mkdir, rename, rm } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import filenamifyUrl from 'filenamify-url';
import { DataFactory, Writer as N3Writer } from 'n3';
import { Writer } from './writer.js';

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

/**
 * Streams RDF quads to files on disk using N3 Writer.
 *
 * Files are named based on the dataset IRI using filenamify-url.
 *
 * A single N3Writer is kept open per dataset across all {@link write} calls,
 * so Turtle prefix declarations are written once and triples can be grouped
 * by subject. Call {@link flush} after all stages complete to finalize the file.
 */
const formatMap: Record<string, string> = {
  turtle: 'Turtle',
  'n-triples': 'N-Triples',
  'n-quads': 'N-Quads',
};

export class FileWriter implements Writer {
  private readonly outputDir: string;
  readonly format: 'turtle' | 'n-triples' | 'n-quads';
  private readonly replacementCharacter: string;
  private readonly prefixes?: Record<string, string>;
  private readonly graphIri?: (dataset: Dataset) => URL;
  private readonly activeWriters = new Map<
    string,
    { n3Writer: N3Writer; stream: WriteStream; tempPath: string }
  >();

  constructor(options: FileWriterOptions) {
    this.outputDir = options.outputDir;
    this.format = options.format ?? 'n-triples';
    this.replacementCharacter = options.replacementCharacter ?? '-';
    this.prefixes = options.prefixes;
    this.graphIri = options.graphIri;
  }

  async write(dataset: Dataset, quads: AsyncIterable<Quad>): Promise<void> {
    // Peek at the first quad to avoid creating empty files.
    const iterator = quads[Symbol.asyncIterator]();
    const first = await iterator.next();
    if (first.done) return;

    const { n3Writer } = await this.getOrCreateWriter(dataset);

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

  async flush(dataset: Dataset): Promise<void> {
    const key = this.getFilePath(dataset);
    const entry = this.activeWriters.get(key);
    if (!entry) return;

    this.activeWriters.delete(key);

    // Quads are streamed to a sibling temp file; only on a clean flush is it
    // atomically renamed onto the final path. A crash therefore leaves at most
    // a stale `*.tmp` — never a truncated final file — so a downstream index
    // rebuild that globs the final extension never reads a half-written file.
    try {
      await new Promise<void>((resolve, reject) => {
        if (entry.stream.errored) {
          reject(entry.stream.errored);
          return;
        }
        entry.n3Writer.end((error) => {
          if (error) reject(error);
          else resolve();
        });
      });
    } catch (error) {
      await rm(entry.tempPath, { force: true, recursive: true });
      throw error;
    }

    await rename(entry.tempPath, key);
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

  private async getOrCreateWriter(
    dataset: Dataset,
  ): Promise<{ n3Writer: N3Writer; stream: WriteStream; tempPath: string }> {
    const key = this.getFilePath(dataset);
    const existing = this.activeWriters.get(key);
    if (existing) return existing;

    await mkdir(dirname(key), { recursive: true });

    // Write to a sibling temp file (same directory, so the flush rename stays on
    // one filesystem and is atomic). The `.tmp` suffix keeps it out of any glob
    // on the final extension.
    const tempPath = `${key}.tmp`;
    const stream = createWriteStream(tempPath, { flags: 'w' });
    stream.on('error', (error) => {
      // Surface stream errors when flushing; prevents 'unhandled error' crashes.
      stream.destroy(error);
    });
    const n3Writer = new N3Writer(stream, {
      format: formatMap[this.format],
      prefixes: this.prefixes,
    });

    const entry = { n3Writer, stream, tempPath };
    this.activeWriters.set(key, entry);
    return entry;
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
