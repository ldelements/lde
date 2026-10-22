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
  static {
    brand(this, 'ImportSuccessful');
  }

  /** Recognises an instance made by any copy of this package, see {@link brand}. */
  static [Symbol.hasInstance](value: unknown): value is ImportSuccessful {
    return isBranded(value, 'ImportSuccessful');
  }

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
  static {
    brand(this, 'ImportFailed');
  }

  /** Recognises an instance made by any copy of this package, see {@link brand}. */
  static [Symbol.hasInstance](value: unknown): value is ImportFailed {
    return isBranded(value, 'ImportFailed');
  }

  constructor(
    public readonly distribution: Distribution,
    public readonly error: string,
  ) {}
}

export class NotSupported {
  static {
    brand(this, 'NotSupported');
  }

  /** Recognises an instance made by any copy of this package, see {@link brand}. */
  static [Symbol.hasInstance](value: unknown): value is NotSupported {
    return isBranded(value, 'NotSupported');
  }

  constructor(public readonly distribution?: Distribution) {}
}

/**
 * Mark a result class’s prototype with a registered symbol, so that
 * `instanceof` holds across copies of this package. An importer and the code
 * that inspects its results each depend on this package, so version skew or
 * an unhoisted install gives each its own copy and therefore its own classes.
 * A plain `instanceof` then fails on every result, and a successful import
 * matches none of the outcomes its caller checks for.
 */
function brand(resultClass: { prototype: object }, name: string): void {
  Object.defineProperty(resultClass.prototype, brandKey(name), {
    value: true,
  });
}

function isBranded(value: unknown, name: string): boolean {
  return typeof value === 'object' && value !== null && brandKey(name) in value;
}

function brandKey(name: string): symbol {
  return Symbol.for(`@lde/sparql-importer.${name}`);
}
