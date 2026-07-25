import { mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import type { ProcessingRecord } from './record.js';
import type { ProvenanceStore } from './store.js';

export interface FileProvenanceStoreOptions {
  /**
   * Path of the JSON file the records are persisted to. Parent directories are
   * created on the first write. Must sit on a durable volume to survive across
   * runs (a Kubernetes CronJob’s container filesystem is discarded).
   */
  path: string;
}

/**
 * A {@link ProvenanceStore} that persists all records to a single JSON file,
 * keyed by dataset URI.
 *
 * For pipelines that run without a triplestore – e.g. a single CronJob
 * persisting to a mounted volume – a JSON file is far lighter than standing
 * up a SPARQL server purely to remember processing records.
 *
 * Writes are atomic (temp file + rename), so a run killed mid-write cannot
 * corrupt the next run’s skip decisions. Safe for a single writer only:
 * concurrent pipeline processes writing the same file lose each other’s
 * updates – use {@link FileLoadedSparqlProvenanceStore} (or file locking)
 * instead. Every access reads the whole file into memory; records are tiny,
 * but at very large dataset counts prefer the SPARQL-backed store.
 */
export class FileProvenanceStore implements ProvenanceStore {
  private readonly path: string;

  constructor(options: FileProvenanceStoreOptions) {
    this.path = options.path;
  }

  /**
   * Verify the file can be written by actually creating (and removing) a
   * probe file next to it. Catches the mount that a non-root runtime user
   * cannot write to (e.g. a root-owned Docker volume, see issue #661) at the
   * start of the run, before writes would silently fail per dataset.
   */
  async check(): Promise<void> {
    try {
      await mkdir(dirname(this.path), { recursive: true });
      const probePath = `${this.path}.${process.pid}.check`;
      await writeFile(probePath, '');
      await unlink(probePath);
    } catch (error) {
      throw new Error(
        `Provenance file ${this.path} is not writable; make its directory writable by the user the pipeline runs as: ${String(error)}`,
        { cause: error },
      );
    }
  }

  async get(datasetUri: URL): Promise<ProcessingRecord | null> {
    const records = await this.readAll();
    return records[datasetUri.toString()] ?? null;
  }

  async set(datasetUri: URL, record: ProcessingRecord): Promise<void> {
    const records = await this.readAll();
    records[datasetUri.toString()] = record;
    await this.writeAll(records);
  }

  private async readAll(): Promise<Record<string, ProcessingRecord>> {
    let json: string;
    try {
      json = await readFile(this.path, 'utf8');
    } catch (error) {
      // A missing file is the empty store: nothing has been processed yet.
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        return {};
      }
      throw error;
    }
    return JSON.parse(json) as Record<string, ProcessingRecord>;
  }

  private async writeAll(
    records: Record<string, ProcessingRecord>,
  ): Promise<void> {
    await mkdir(dirname(this.path), { recursive: true });
    const temporaryPath = `${this.path}.${process.pid}.tmp`;
    await writeFile(temporaryPath, `${JSON.stringify(records, null, 2)}\n`);
    await rename(temporaryPath, this.path); // Atomic on POSIX filesystems.
  }
}
