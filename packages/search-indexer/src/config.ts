import { Dataset } from '@lde/dataset';
import type { SearchCriteria } from '@lde/dataset-registry-client';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * The indexer’s complete runtime configuration, read from environment
 * variables ({@link configFromEnvironment}) – the contract of the Docker
 * image. Everything schema-shaped lives in the mounted schema module instead,
 * the same file the served-API image mounts.
 */
export interface IndexerConfig {
  /** Path of the mounted schema-declaration module (`SCHEMA_MODULE`). */
  readonly schemaModulePath: string;
  /** SPARQL endpoint of the DCAT dataset registry the selection queries
   *  (`REGISTRY_ENDPOINT`). Undefined when `DATASETS` names only local data, so
   *  the run has no registry to read. */
  readonly registryEndpoint?: URL;
  /**
   * Root types extracted from {@link registryEndpoint} instead of from each
   * dataset’s own distribution (`REGISTRY_ROOT_TYPES`, whitespace- or
   * comma-separated {@link SearchType.name}s) – the dataset’s own description
   * and what hangs off it, which live in the register rather than in the data a
   * publisher ships. Empty when unset: every type reads the distribution, the
   * behaviour before this setting existed.
   */
  readonly registryRootTypes: readonly string[];
  /** Dataset selection within the registry: explicit IRIs (`DATASETS`),
   *  search criteria (`DATASET_CRITERIA`), or every dataset when neither is
   *  set. */
  readonly datasetCriteria: SearchCriteria;
  /**
   * A SPARQL graph pattern over `?root` per root type, keyed by
   * {@link SearchType.name}, that restricts which instances of the type are
   * indexed, in every dataset (`RESTRICT_ROOTS`, a JSON object). Empty when
   * unset: every root is indexed. The names and patterns are validated against
   * the mounted schema when the pipeline is wired.
   */
  readonly restrictRoots: Readonly<Record<string, string>>;
  /** Local data to index besides what the registry selects, from the `file:`
   *  URLs in `DATASETS`: paths of files, each one dataset, and of directories,
   *  which end in `/`, with one dataset per RDF file. */
  readonly localSources: readonly string[];
  /** Where the Typesense engine writes (`TYPESENSE_*`). */
  readonly typesense: TypesenseConnection;
  /** How each type’s collection is rebuilt (`REBUILD_MODE`): update the live
   *  collection in place, or build a fresh one and swap on commit. */
  readonly rebuildMode: 'in-place' | 'blue-green';
  /** Prefix prepended to every derived collection name
   *  (`COLLECTION_PREFIX`), e.g. for a shared multi-tenant engine. */
  readonly collectionPrefix?: string;
  /**
   * Stemming language for text that carries no language tag (`DEFAULT_LOCALE`,
   * e.g. `nl`). Unset, such text is folded but **unstemmed** – no language is
   * ever assumed – so `fietsen` does not match `fiets`. Text declaring a real
   * locale always stems in its own language, whatever this says.
   */
  readonly defaultLocale?: string;
  /** Per-dataset processing memory: skip unchanged datasets
   *  (`PROVENANCE_FILE` + `PIPELINE_VERSION`). */
  readonly provenance?: ProvenanceConfig;
  /** The QLever import path (`QLEVER_MODE` + `QLEVER_IMAGE` +
   *  `IMPORT_STRATEGY` + `DATA_DIR` + `QLEVER_MEMORY_MAX_SIZE`): import data dumps into a
   *  pipeline-controlled QLever instead of relying on live SPARQL endpoints
   *  alone. */
  readonly qlever?: QleverConfig;
}

/** Connection details of the Typesense node the indexer writes to. */
export interface TypesenseConnection {
  readonly host: string;
  readonly port: number;
  readonly protocol: 'http' | 'https';
  /** An admin key: the indexer creates, writes and swaps collections. */
  readonly apiKey: string;
}

/** File-backed provenance: both halves required, so a skip-enabled pipeline
 *  can never run without the version that keys its skip decisions. */
export interface ProvenanceConfig {
  /** Path of the JSON provenance file; must sit on a durable volume. */
  readonly path: string;
  /** Consumer-declared version of the indexer’s output-affecting logic. */
  readonly pipelineVersion: string;
}

/**
 * The pipeline-controlled QLever the import path imports into, discriminated
 * by `QLEVER_MODE`.
 */
export type QleverConfig = {
  /** When to import a data dump instead of querying a live endpoint. */
  readonly strategy: 'sparql' | 'sparqlWithImportFallback' | 'import';
  /** Directory for downloaded dumps and QLever index caches. */
  readonly dataDir: string;
  /**
   * The memory QLever may reserve for answering queries
   * (`QLEVER_MEMORY_MAX_SIZE`, QLever’s `--memory-max-size`), e.g. `8G`.
   * QLever refuses a query that would exceed it, with an HTTP 500 such as
   * “Tried to allocate 8 MB, but only 5.8 MB were available”. Unset, the
   * `@lde/sparql-qlever` default applies.
   */
  readonly memoryMaxSize?: string;
} & (
  | {
      /** A sibling container the indexer starts over the Docker socket. */
      readonly mode: 'docker';
      /** QLever Docker image to run, e.g. `adfreiburg/qlever:latest`. */
      readonly image: string;
      /** Docker network the spawned QLever joins (`QLEVER_NETWORK`), reached
       *  by container name. Required when the indexer itself runs
       *  containerized on a bridge network; without it QLever is published on
       *  the host and addressed as `localhost`. */
      readonly network?: string;
    }
  | {
      /** A sidecar in the indexer’s pod, controlled through the task agent
       *  of `@lde/task-runner-http`. The pod sets its image. */
      readonly mode: 'remote';
    }
);

const QLEVER_MODES = ['docker', 'remote'] as const;

/** A size QLever’s `--memory-max-size` reads: a number and a unit, such as
 *  `8G`, `8 GB` or `512M`. */
const MEMORY_SIZE = /^\d+(\.\d+)?\s?[kmgt]b?$/i;

const IMPORT_STRATEGIES = [
  'sparql',
  'sparqlWithImportFallback',
  'import',
] as const;

/**
 * Read the {@link IndexerConfig} from environment variables. Reports **all**
 * problems in one error – a misconfigured deployment learns everything
 * wrong with it from a single boot attempt, not one variable per crash loop.
 */
export function configFromEnvironment(
  environment: Readonly<Record<string, string | undefined>>,
): IndexerConfig {
  const problems: string[] = [];

  const required = (name: string): string => {
    const value = environment[name];
    if (value === undefined || value.length === 0) {
      problems.push(`${name} is required`);
      return '';
    }
    return value;
  };
  const integer = (name: string, fallback: number): number => {
    const value = environment[name];
    if (value === undefined || value.length === 0) {
      return fallback;
    }
    const parsed = Number(value);
    if (!Number.isInteger(parsed) || parsed < 0) {
      problems.push(`${name} must be a non-negative integer, got “${value}”`);
      return fallback;
    }
    return parsed;
  };
  const url = (name: string, value: string): URL => {
    try {
      return new URL(value);
    } catch {
      // An empty value is already reported as missing by required().
      if (value.length > 0) {
        problems.push(`${name} must be an absolute URL, got “${value}”`);
      }
      return new URL('http://invalid.invalid');
    }
  };

  const datasets = names(environment['DATASETS']);
  const registryEndpoint =
    datasets.length > 0 && datasets.every(isLocal)
      ? undefined
      : url('REGISTRY_ENDPOINT', required('REGISTRY_ENDPOINT'));
  if (registryEndpoint?.protocol === 'file:') {
    problems.push(
      'REGISTRY_ENDPOINT must be a SPARQL endpoint: name local files and directories in DATASETS',
    );
  }

  const protocol = environment['TYPESENSE_PROTOCOL'] ?? 'http';
  if (protocol !== 'http' && protocol !== 'https') {
    problems.push(
      `TYPESENSE_PROTOCOL must be “http” or “https”, got “${protocol}”`,
    );
  }

  const rebuildMode = environment['REBUILD_MODE'] ?? 'in-place';
  if (rebuildMode !== 'in-place' && rebuildMode !== 'blue-green') {
    problems.push(
      `REBUILD_MODE must be “in-place” or “blue-green”, got “${rebuildMode}”`,
    );
  }

  const datasetCriteria = criteriaFromEnvironment(
    environment,
    datasets,
    problems,
  );
  const provenance = provenanceFromEnvironment(
    environment,
    rebuildMode,
    problems,
  );
  const qlever = qleverFromEnvironment(environment, problems);
  const localSources = localSourcesFrom(datasets, qlever, problems);

  const config: IndexerConfig = {
    schemaModulePath:
      environment['SCHEMA_MODULE'] ?? '/config/search-schema.mjs',
    registryEndpoint,
    registryRootTypes: names(environment['REGISTRY_ROOT_TYPES']),
    datasetCriteria,
    restrictRoots: restrictRootsFromEnvironment(environment, problems),
    localSources,
    typesense: {
      host: required('TYPESENSE_HOST'),
      port: integer('TYPESENSE_PORT', 8108),
      protocol: protocol as 'http' | 'https',
      apiKey: required('TYPESENSE_API_KEY'),
    },
    rebuildMode: rebuildMode as 'in-place' | 'blue-green',
    collectionPrefix: environment['COLLECTION_PREFIX'],
    defaultLocale: environment['DEFAULT_LOCALE'],
    provenance,
    qlever,
  };
  if (problems.length > 0) {
    throw new Error(
      `Invalid configuration:\n${problems.map((problem) => `- ${problem}`).join('\n')}`,
    );
  }
  return config;
}

/**
 * A whitespace- or comma-separated list variable, as a list. The names
 * themselves are validated against the mounted schema when the pipeline is
 * wired – config has no schema to check them against.
 */
function names(value: string | undefined): readonly string[] {
  return value === undefined
    ? []
    : value.split(/[\s,]+/).filter((name) => name.length > 0);
}

/** Whether a `DATASETS` entry names local data rather than a registered dataset.
 *  Parsed, because a URL scheme is case-insensitive. */
function isLocal(entry: string): boolean {
  return URL.parse(entry)?.protocol === 'file:';
}

/** The paths of the `file:` URLs in `DATASETS`. Only QLever can read a file, so
 *  they require the import path. */
function localSourcesFrom(
  datasets: readonly string[],
  qlever: QleverConfig | undefined,
  problems: string[],
): readonly string[] {
  const entries = datasets.filter(isLocal);
  if (entries.length > 0 && !qlever) {
    problems.push(
      'A file: URL in DATASETS requires QLEVER_IMAGE or QLEVER_MODE=remote: a file must be imported before it can be queried',
    );
  }
  const paths = entries.flatMap((entry) => {
    try {
      const path = fileURLToPath(entry);
      if (!path.endsWith('/')) {
        Dataset.localFile(path);
      }
      return [path];
    } catch (error) {
      problems.push(
        `DATASETS contains “${entry}”, which is not a local RDF file or a directory ending in /: ${(error as Error).message}`,
      );
      return [];
    }
  });
  const directories = new Set(paths.filter((path) => path.endsWith('/')));
  paths.forEach((path, index) => {
    if (paths.indexOf(path) !== index) {
      problems.push(`DATASETS lists “${path}” twice`);
    } else if (!path.endsWith('/') && directories.has(`${dirname(path)}/`)) {
      problems.push(
        `DATASETS lists “${path}” and its directory, which already selects it`,
      );
    }
  });
  return paths;
}

/** `DATASETS` (whitespace-separated IRIs, of which `file:` URLs are local data
 *  rather than registered datasets) or `DATASET_CRITERIA` (a JSON object) –
 *  never both; neither selects the whole registry. */
function criteriaFromEnvironment(
  environment: Readonly<Record<string, string | undefined>>,
  datasets: readonly string[],
  problems: string[],
): SearchCriteria {
  const criteriaJson = environment['DATASET_CRITERIA'];
  if (environment['DATASETS'] && criteriaJson) {
    problems.push(
      'DATASETS and DATASET_CRITERIA are mutually exclusive; set at most one',
    );
    return {};
  }
  if (environment['DATASETS']) {
    const iris = datasets.filter((iri) => !isLocal(iri));
    for (const iri of iris) {
      try {
        new URL(iri);
      } catch {
        problems.push(`DATASETS contains “${iri}”, which is not an IRI`);
      }
    }
    return { $id: iris };
  }
  if (criteriaJson) {
    try {
      const parsed: unknown = JSON.parse(criteriaJson);
      if (
        typeof parsed !== 'object' ||
        parsed === null ||
        Array.isArray(parsed)
      ) {
        problems.push('DATASET_CRITERIA must be a JSON object');
        return {};
      }
      return parsed as SearchCriteria;
    } catch {
      problems.push('DATASET_CRITERIA must be valid JSON');
      return {};
    }
  }
  return {};
}

/** `RESTRICT_ROOTS`: a JSON object mapping root type names to SPARQL graph
 *  patterns; empty when unset. */
function restrictRootsFromEnvironment(
  environment: Readonly<Record<string, string | undefined>>,
  problems: string[],
): Readonly<Record<string, string>> {
  const json = environment['RESTRICT_ROOTS'];
  if (!json) return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    problems.push('RESTRICT_ROOTS must be valid JSON');
    return {};
  }
  if (
    typeof parsed !== 'object' ||
    parsed === null ||
    Array.isArray(parsed) ||
    !Object.values(parsed).every((pattern) => typeof pattern === 'string')
  ) {
    problems.push(
      'RESTRICT_ROOTS must be a JSON object mapping type names to graph patterns',
    );
    return {};
  }
  return parsed as Record<string, string>;
}

function provenanceFromEnvironment(
  environment: Readonly<Record<string, string | undefined>>,
  rebuildMode: string,
  problems: string[],
): ProvenanceConfig | undefined {
  const path = environment['PROVENANCE_FILE'];
  const pipelineVersion = environment['PIPELINE_VERSION'];
  if (!path && !pipelineVersion) {
    return undefined;
  }
  if (!path || !pipelineVersion) {
    problems.push(
      'PROVENANCE_FILE and PIPELINE_VERSION must be set together: the version keys the skip decisions the file remembers',
    );
    return undefined;
  }
  if (rebuildMode === 'blue-green') {
    problems.push(
      'PROVENANCE_FILE cannot be combined with REBUILD_MODE=blue-green: a skipped dataset would be missing from the fresh collection the swap makes live',
    );
    return undefined;
  }
  return { path, pipelineVersion };
}

function qleverFromEnvironment(
  environment: Readonly<Record<string, string | undefined>>,
  problems: string[],
): QleverConfig | undefined {
  const image = environment['QLEVER_IMAGE'];
  const strategy = environment['IMPORT_STRATEGY'];
  const network = environment['QLEVER_NETWORK'];
  const memoryMaxSize = environment['QLEVER_MEMORY_MAX_SIZE'];
  // QLEVER_IMAGE alone is how the Docker mode has always been enabled. An
  // empty QLEVER_MODE, as a template renders an unset one, counts as unset.
  const mode = environment['QLEVER_MODE'] || (image ? 'docker' : undefined);
  if (mode === undefined) {
    if (strategy) {
      problems.push(
        'IMPORT_STRATEGY requires QLEVER_IMAGE or QLEVER_MODE=remote: without an import engine there is nothing to import into',
      );
    }
    if (network) {
      problems.push(
        'QLEVER_NETWORK requires QLEVER_IMAGE: without an import engine there is no QLever container to attach',
      );
    }
    if (memoryMaxSize) {
      problems.push(
        'QLEVER_MEMORY_MAX_SIZE requires QLEVER_IMAGE or QLEVER_MODE=remote: without an import engine there is no QLever to size',
      );
    }
    return undefined;
  }
  if (!(QLEVER_MODES as readonly string[]).includes(mode)) {
    problems.push(
      `QLEVER_MODE must be one of ${QLEVER_MODES.map((name) => `“${name}”`).join(', ')}, got “${mode}”`,
    );
    return undefined;
  }
  if (
    strategy !== undefined &&
    !(IMPORT_STRATEGIES as readonly string[]).includes(strategy)
  ) {
    problems.push(
      `IMPORT_STRATEGY must be one of ${IMPORT_STRATEGIES.map((name) => `“${name}”`).join(', ')}, got “${strategy}”`,
    );
  }
  if (memoryMaxSize && !MEMORY_SIZE.test(memoryMaxSize)) {
    problems.push(
      `QLEVER_MEMORY_MAX_SIZE must be a size such as “8G” or “8 GB”, got “${memoryMaxSize}”`,
    );
  }
  const common = {
    strategy: (strategy ?? 'sparql') as QleverConfig['strategy'],
    dataDir: environment['DATA_DIR'] ?? '/data',
    ...(memoryMaxSize ? { memoryMaxSize } : {}),
  };
  if (mode === 'remote') {
    if (image) {
      problems.push(
        'QLEVER_IMAGE cannot be combined with QLEVER_MODE=remote: the pod sets the QLever sidecar’s image',
      );
    }
    if (network) {
      problems.push(
        'QLEVER_NETWORK cannot be combined with QLEVER_MODE=remote: the sidecar shares the indexer’s network namespace',
      );
    }
    return { ...common, mode: 'remote' };
  }
  if (!image) {
    problems.push(
      'QLEVER_MODE=docker requires QLEVER_IMAGE: the image to start QLever containers from',
    );
    return undefined;
  }
  return { ...common, mode: 'docker', image, network };
}
