import {
  ConstantTimeoutPolicy,
  Stage,
  SparqlConstructExecutor,
  SparqlItemSelector,
  readQueryFile,
  type Executor,
  type ItemSelector,
} from '@lde/pipeline';
import { assertSafeIri } from '@lde/dataset';
import type { Quad } from '@rdfjs/types';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  VocabularyExecutor,
  defaultVocabularies,
} from './vocabularyAnalyzer.js';
import { UriSpaceExecutor } from './uriSpaceExecutor.js';

const queriesDir = resolve(
  dirname(fileURLToPath(import.meta.url)),
  '..',
  'queries',
);

/**
 * Options for configuring VoID stage execution.
 */
export interface VoidStageOptions {
  /** SPARQL query timeout in milliseconds. @default 60000 */
  timeout?: number;
}

/**
 * Options for per-class VoID stages that iterate over classes.
 *
 * `batchSize` and `maxConcurrency` control how class bindings are batched
 * and processed concurrently — they have no effect on global (non-per-class) stages.
 */
export interface PerClassVoidStageOptions extends VoidStageOptions {
  /** Maximum number of class bindings per executor call. @default 10 */
  batchSize?: number;
  /** Maximum concurrent in-flight executor batches. @default 10 */
  maxConcurrency?: number;
  /** When true, iterate queries per class using a class selector. @default true */
  perClass?: boolean;
}

/**
 * Options for the {@link voidStages} convenience function.
 */
export interface VoidStagesOptions extends PerClassVoidStageOptions {
  /** When provided, includes the object URI space stage using this map. */
  uriSpaces?: ReadonlyMap<string, readonly Quad[]>;
  /** Additional vocabulary namespace URIs to detect beyond the built-in defaults. */
  vocabularies?: readonly string[];
}

async function createVoidStage(
  filename: string,
  options?: VoidStageOptions & {
    executor?: (query: string) => Executor;
    perClass?: boolean;
    batchSize?: number;
    maxConcurrency?: number;
  },
): Promise<Stage> {
  const query = await readQueryFile(resolve(queriesDir, filename));
  const executor =
    options?.executor?.(query) ??
    new SparqlConstructExecutor({
      query,
      timeoutPolicy: new ConstantTimeoutPolicy(options?.timeout ?? 60_000),
    });

  if (options?.perClass) {
    return new Stage({
      name: filename,
      itemSelector: classSelector(),
      executors: executor,
      batchSize: options?.batchSize,
      maxConcurrency: options?.maxConcurrency,
    });
  }
  return new Stage({
    name: filename,
    executors: executor,
  });
}

function classSelector(): ItemSelector {
  return {
    select: (distribution, batchSize) => {
      const subjectFilter = distribution.subjectFilter ?? '';
      let fromClause = '';
      if (distribution.namedGraph) {
        assertSafeIri(distribution.namedGraph);
        fromClause = `FROM <${distribution.namedGraph}>`;
      }
      const selectorQuery = [
        'SELECT DISTINCT ?class',
        fromClause,
        `WHERE { ${subjectFilter} ?s a ?class . }`,
        'LIMIT 1000',
      ].join('\n');

      return new SparqlItemSelector({
        query: selectorQuery,
      }).select(distribution, batchSize);
    },
  };
}

// Global stages

export function subjectUriSpaces(options?: VoidStageOptions): Promise<Stage> {
  return createVoidStage('subject-uri-space.rq', options);
}

export function classPartitions(options?: VoidStageOptions): Promise<Stage> {
  return createVoidStage('class-partition.rq', options);
}

export function countObjectLiterals(
  options?: VoidStageOptions,
): Promise<Stage> {
  return createVoidStage('object-literals.rq', options);
}

export function countObjectUris(options?: VoidStageOptions): Promise<Stage> {
  return createVoidStage('object-uris.rq', options);
}

export function countProperties(options?: VoidStageOptions): Promise<Stage> {
  return createVoidStage('properties.rq', options);
}

export function countSubjects(options?: VoidStageOptions): Promise<Stage> {
  return createVoidStage('subjects.rq', options);
}

export function countTriples(options?: VoidStageOptions): Promise<Stage> {
  return createVoidStage('triples.rq', options);
}

export function classPropertySubjects(
  options?: PerClassVoidStageOptions,
): Promise<Stage> {
  return createVoidStage('class-properties-subjects.rq', {
    ...options,
    perClass: options?.perClass ?? true,
  });
}

export function classPropertyObjects(
  options?: PerClassVoidStageOptions,
): Promise<Stage> {
  return createVoidStage('class-properties-objects.rq', {
    ...options,
    perClass: options?.perClass ?? true,
  });
}

export function countDatatypes(options?: VoidStageOptions): Promise<Stage> {
  return createVoidStage('datatypes.rq', options);
}

export function detectLicenses(options?: VoidStageOptions): Promise<Stage> {
  return createVoidStage('licenses.rq', options);
}

// Per-class stages

export function perClassObjectClasses(
  options?: PerClassVoidStageOptions,
): Promise<Stage> {
  return createVoidStage('class-property-object-classes.rq', {
    ...options,
    perClass: options?.perClass ?? true,
  });
}

export function perClassDatatypes(
  options?: PerClassVoidStageOptions,
): Promise<Stage> {
  return createVoidStage('class-property-datatypes.rq', {
    ...options,
    perClass: options?.perClass ?? true,
  });
}

export function perClassLanguages(
  options?: PerClassVoidStageOptions,
): Promise<Stage> {
  return createVoidStage('class-property-languages.rq', {
    ...options,
    perClass: options?.perClass ?? true,
  });
}

// Domain-specific executor stages

export function uriSpaces(
  uriSpaceMap: ReadonlyMap<string, readonly Quad[]>,
  options?: VoidStageOptions,
): Promise<Stage> {
  return createVoidStage('object-uri-space.rq', {
    ...options,
    executor: (query) =>
      new UriSpaceExecutor(
        new SparqlConstructExecutor({
          query,
          timeoutPolicy: new ConstantTimeoutPolicy(options?.timeout ?? 60_000),
        }),
        uriSpaceMap,
      ),
  });
}

export interface DetectVocabulariesOptions extends VoidStageOptions {
  /** Additional vocabulary namespace URIs to detect beyond the built-in defaults. */
  vocabularies?: readonly string[];
}

export function detectVocabularies(
  options?: DetectVocabulariesOptions,
): Promise<Stage> {
  return createVoidStage('entity-properties.rq', {
    ...options,
    executor: (query) =>
      new VocabularyExecutor(
        new SparqlConstructExecutor({
          query,
          timeoutPolicy: new ConstantTimeoutPolicy(options?.timeout ?? 60_000),
        }),
        options?.vocabularies
          ? [...defaultVocabularies, ...options.vocabularies]
          : undefined,
      ),
  });
}

/**
 * Create all VoID analysis stages in their recommended execution order.
 *
 * The stages are ordered so that {@link classPartitions} runs before the
 * per-class stages. This warms up the `?s a ?class` pattern cache on the
 * SPARQL endpoint, preventing 504 timeouts on the heavier per-class queries
 * when the cache is cold.
 */
export async function voidStages(
  options?: VoidStagesOptions,
): Promise<Stage[]> {
  const {
    uriSpaces: uriSpaceMap,
    vocabularies,
    ...stageOptions
  } = options ?? {};

  return Promise.all([
    // Global counting stages.
    countSubjects(stageOptions),
    countProperties(stageOptions),
    countObjectLiterals(stageOptions),
    countObjectUris(stageOptions),
    countDatatypes(stageOptions),
    countTriples(stageOptions),

    // Cache warming — must precede per-class stages.
    classPartitions(stageOptions),

    // Per-class stages.
    classPropertySubjects(stageOptions),
    classPropertyObjects(stageOptions),
    perClassDatatypes(stageOptions),
    perClassObjectClasses(stageOptions),
    perClassLanguages(stageOptions),

    // Other stages.
    detectLicenses(stageOptions),
    detectVocabularies({ ...stageOptions, vocabularies }),
    subjectUriSpaces(stageOptions),
    ...(uriSpaceMap ? [uriSpaces(uriSpaceMap, stageOptions)] : []),
  ]);
}
