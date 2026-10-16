import { Distribution } from '@lde/dataset';
import { Downloader } from '@lde/distribution-downloader';
import { TaskRunner } from '@lde/task-runner';

/** Store-agnostic options shared by all {@link Importer} implementations. */
export interface ImporterOptions {
  taskRunner: TaskRunner<unknown>;
  downloader?: Downloader;
  /** Cache indices and skip re-indexing when source data is unchanged. @default true */
  cacheIndex?: boolean;
}

/**
 * An Importer selects a suitable {@link Distribution} from the given candidates
 * and imports it to a SPARQL server.
 *
 * This assumes that all Distributions of a dataset are roughly equivalent:
 * https://docs.nde.nl/requirements-datasets/#dataset-distributions.
 */
export interface Importer {
  /**
   * Import one of the given {@link Distribution}s to a SPARQL server.
   *
   * The importer picks the first distribution whose format it supports,
   * downloads it, and indexes it. Returns {@link NotSupported} when none of
   * the distributions use a supported format.
   */
  import(
    distributions: Distribution[],
  ): Promise<NotSupported | ImportFailed | ImportSuccessful>;
}

export class ImportSuccessful {
  constructor(
    public readonly distribution: Distribution,
    public readonly identifier?: string,
    public readonly tripleCount?: number,
    public readonly warnings: string[] = [],
    /** The engine that built the imported data, when the importer can tell.
     *  For a cached index this is the engine that built it, which may differ
     *  from the one that serves it. */
    public readonly engine?: Engine,
  ) {}
}

/** A store engine, identified as precisely as it identifies itself. */
export interface Engine {
  /** Human-readable name, e.g. `QLever`. */
  readonly name: string;
  /** The engine’s own version identifier, such as a release number or a
   *  commit hash. */
  readonly version: string;
}

export class ImportFailed {
  constructor(
    public readonly distribution: Distribution,
    public readonly error: string,
  ) {}
}

export class NotSupported {
  constructor(public readonly distribution?: Distribution) {}
}
