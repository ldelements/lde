import type { SearchCriteria } from '@lde/dataset-registry-client';

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
   *  (`REGISTRY_ENDPOINT`). */
  readonly registryEndpoint: URL;
  /** Dataset selection within the registry: explicit IRIs (`DATASETS`),
   *  search criteria (`DATASET_CRITERIA`), or every dataset when neither is
   *  set. */
  readonly datasetCriteria: SearchCriteria;
  /** Where the Typesense engine writes (`TYPESENSE_*`). */
  readonly typesense: TypesenseConnection;
  /** How each type’s collection is rebuilt (`REBUILD_MODE`): update the live
   *  collection in place, or build a fresh one and swap on commit. */
  readonly rebuildMode: 'in-place' | 'blue-green';
  /** Prefix prepended to every derived collection name
   *  (`COLLECTION_PREFIX`), e.g. for a shared multi-tenant engine. */
  readonly collectionPrefix?: string;
  /** Per-dataset processing memory: skip unchanged datasets
   *  (`PROVENANCE_FILE` + `PIPELINE_VERSION`). */
  readonly provenance?: ProvenanceConfig;
  /** The QLever import path (`QLEVER_IMAGE` + `IMPORT_STRATEGY` +
   *  `DATA_DIR`): import data dumps into a pipeline-controlled QLever
   *  container instead of relying on live SPARQL endpoints alone. */
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

/** The pipeline-controlled QLever sibling container (Docker socket mode). */
export interface QleverConfig {
  /** QLever Docker image to run, e.g. `adfreiburg/qlever:latest`. */
  readonly image: string;
  /** When to import a data dump instead of querying a live endpoint. */
  readonly strategy: 'sparql' | 'sparqlWithImportFallback' | 'import';
  /** Directory for downloaded dumps and QLever index caches. */
  readonly dataDir: string;
}

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

  const registryEndpoint = url(
    'REGISTRY_ENDPOINT',
    required('REGISTRY_ENDPOINT'),
  );

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

  const datasetCriteria = criteriaFromEnvironment(environment, problems);
  const provenance = provenanceFromEnvironment(
    environment,
    rebuildMode,
    problems,
  );
  const qlever = qleverFromEnvironment(environment, problems);

  const config: IndexerConfig = {
    schemaModulePath:
      environment['SCHEMA_MODULE'] ?? '/config/search-schema.mjs',
    registryEndpoint,
    datasetCriteria,
    typesense: {
      host: required('TYPESENSE_HOST'),
      port: integer('TYPESENSE_PORT', 8108),
      protocol: protocol as 'http' | 'https',
      apiKey: required('TYPESENSE_API_KEY'),
    },
    rebuildMode: rebuildMode as 'in-place' | 'blue-green',
    collectionPrefix: environment['COLLECTION_PREFIX'],
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

/** `DATASETS` (whitespace-separated IRIs) or `DATASET_CRITERIA` (a JSON
 *  object) – never both; neither selects the whole registry. */
function criteriaFromEnvironment(
  environment: Readonly<Record<string, string | undefined>>,
  problems: string[],
): SearchCriteria {
  const datasets = environment['DATASETS'];
  const criteriaJson = environment['DATASET_CRITERIA'];
  if (datasets && criteriaJson) {
    problems.push(
      'DATASETS and DATASET_CRITERIA are mutually exclusive; set at most one',
    );
    return {};
  }
  if (datasets) {
    const iris = datasets.split(/[\s,]+/).filter((iri) => iri.length > 0);
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
  if (!image) {
    if (strategy) {
      problems.push(
        'IMPORT_STRATEGY requires QLEVER_IMAGE: without an import engine there is nothing to import into',
      );
    }
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
  return {
    image,
    strategy: (strategy ?? 'sparql') as QleverConfig['strategy'],
    dataDir: environment['DATA_DIR'] ?? '/data',
  };
}
