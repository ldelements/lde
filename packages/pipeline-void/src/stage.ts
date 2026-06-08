import {
  Stage,
  SparqlConstructExecutor,
  SparqlItemSelector,
  composeDecorators,
  readQueryFile,
  type ExecutorDecorator,
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
 * Stable names of the individual VoID stages, keyed by a readable identifier
 * and valued by the query filename used as the stage name.
 *
 * Consumers reference these keys when targeting a specific stage — for example
 * to route an {@link ExecutorDecorator} through {@link VoidStagesOptions.decorators}
 * — so they never have to hard-code a `.rq` filename and an invalid key becomes
 * a compile error rather than a silent no-op.
 */
export const VOID_STAGE_NAMES = {
  subjects: 'subjects.rq',
  properties: 'properties.rq',
  objectLiterals: 'object-literals.rq',
  objectUris: 'object-uris.rq',
  datatypes: 'datatypes.rq',
  triples: 'triples.rq',
  classPartition: 'class-partition.rq',
  classPropertiesSubjects: 'class-properties-subjects.rq',
  classPropertiesObjects: 'class-properties-objects.rq',
  classPropertyDatatypes: 'class-property-datatypes.rq',
  classPropertyObjectClasses: 'class-property-object-classes.rq',
  classPropertyLanguages: 'class-property-languages.rq',
  licenses: 'licenses.rq',
  entityProperties: 'entity-properties.rq',
  subjectUriSpace: 'subject-uri-space.rq',
  objectUriSpace: 'object-uri-space.rq',
} as const;

/** The name (query filename) of one VoID stage. */
export type VoidStageName =
  (typeof VOID_STAGE_NAMES)[keyof typeof VOID_STAGE_NAMES];

/**
 * Options for configuring VoID stage execution.
 *
 * Per-request timeouts are configured at the {@link Pipeline} level via
 * `PipelineOptions.timeout`; VoID stages no longer expose their own timeout
 * knob. Kept as a named type so per-class / per-stages option types can
 * extend it as more knobs are added.
 */
// eslint-disable-next-line @typescript-eslint/no-empty-interface, @typescript-eslint/no-empty-object-type
export interface VoidStageOptions {}

/**
 * Mix-in for the standalone per-stage functions, letting a single stage be
 * decorated in isolation.
 *
 * Kept off the base {@link VoidStageOptions} on purpose: {@link VoidStagesOptions}
 * extends that base, and a lone `decorate` there would be ambiguous about which
 * of the many stages it targets. The bundle uses {@link VoidStagesOptions.decorators}
 * — keyed per stage — instead.
 */
export interface DecoratableStageOptions {
  /**
   * Wraps this stage's executor. The stage always builds its own default
   * executor (including any built-in decorator); this wraps it from the
   * outside. See {@link ExecutorDecorator} for the scope contract.
   */
  decorate?: ExecutorDecorator;
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
  /**
   * Per-stage executor decorators, keyed by {@link VoidStageName}.
   *
   * Each decorator wraps the matching stage's executor from the outside,
   * composing over any built-in decorator the stage applies (e.g. the URI space
   * aggregator or vocabulary detector) rather than replacing it. Use
   * {@link VOID_STAGE_NAMES} for the keys so an invalid stage name is a compile
   * error.
   */
  decorators?: Partial<Record<VoidStageName, ExecutorDecorator>>;
}

async function createVoidStage(
  filename: VoidStageName,
  options?: PerClassVoidStageOptions &
    DecoratableStageOptions & {
      /** Decorator the stage itself applies, e.g. URI space or vocabulary detection. */
      builtIn?: ExecutorDecorator;
    },
): Promise<Stage> {
  const query = await readQueryFile(resolve(queriesDir, filename));
  // Built-in decorator wraps the base executor; the consumer's decorator wraps
  // that, so it composes over (never clobbers) any built-in behaviour.
  const decorate = composeDecorators(options?.builtIn, options?.decorate);
  const executor = decorate(new SparqlConstructExecutor({ query }));

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
    // Forward `options` so the Pipeline’s per-dataset TimeoutPolicy
    // reaches the inner SparqlItemSelector — without this the adaptive
    // budget is silently bypassed for class selection.
    select: (distribution, batchSize, options) => {
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
      }).select(distribution, batchSize, options);
    },
  };
}

// Global stages

export function subjectUriSpaces(
  options?: VoidStageOptions & DecoratableStageOptions,
): Promise<Stage> {
  return createVoidStage(VOID_STAGE_NAMES.subjectUriSpace, options);
}

export function classPartitions(
  options?: VoidStageOptions & DecoratableStageOptions,
): Promise<Stage> {
  return createVoidStage(VOID_STAGE_NAMES.classPartition, options);
}

export function countObjectLiterals(
  options?: VoidStageOptions & DecoratableStageOptions,
): Promise<Stage> {
  return createVoidStage(VOID_STAGE_NAMES.objectLiterals, options);
}

export function countObjectUris(
  options?: VoidStageOptions & DecoratableStageOptions,
): Promise<Stage> {
  return createVoidStage(VOID_STAGE_NAMES.objectUris, options);
}

export function countProperties(
  options?: VoidStageOptions & DecoratableStageOptions,
): Promise<Stage> {
  return createVoidStage(VOID_STAGE_NAMES.properties, options);
}

export function countSubjects(
  options?: VoidStageOptions & DecoratableStageOptions,
): Promise<Stage> {
  return createVoidStage(VOID_STAGE_NAMES.subjects, options);
}

export function countTriples(
  options?: VoidStageOptions & DecoratableStageOptions,
): Promise<Stage> {
  return createVoidStage(VOID_STAGE_NAMES.triples, options);
}

export function classPropertySubjects(
  options?: PerClassVoidStageOptions & DecoratableStageOptions,
): Promise<Stage> {
  return createVoidStage(VOID_STAGE_NAMES.classPropertiesSubjects, {
    ...options,
    perClass: options?.perClass ?? true,
  });
}

export function classPropertyObjects(
  options?: PerClassVoidStageOptions & DecoratableStageOptions,
): Promise<Stage> {
  return createVoidStage(VOID_STAGE_NAMES.classPropertiesObjects, {
    ...options,
    perClass: options?.perClass ?? true,
  });
}

export function countDatatypes(
  options?: VoidStageOptions & DecoratableStageOptions,
): Promise<Stage> {
  return createVoidStage(VOID_STAGE_NAMES.datatypes, options);
}

export function detectLicenses(
  options?: VoidStageOptions & DecoratableStageOptions,
): Promise<Stage> {
  return createVoidStage(VOID_STAGE_NAMES.licenses, options);
}

// Per-class stages

export function perClassObjectClasses(
  options?: PerClassVoidStageOptions & DecoratableStageOptions,
): Promise<Stage> {
  return createVoidStage(VOID_STAGE_NAMES.classPropertyObjectClasses, {
    ...options,
    perClass: options?.perClass ?? true,
  });
}

export function perClassDatatypes(
  options?: PerClassVoidStageOptions & DecoratableStageOptions,
): Promise<Stage> {
  return createVoidStage(VOID_STAGE_NAMES.classPropertyDatatypes, {
    ...options,
    perClass: options?.perClass ?? true,
  });
}

export function perClassLanguages(
  options?: PerClassVoidStageOptions & DecoratableStageOptions,
): Promise<Stage> {
  return createVoidStage(VOID_STAGE_NAMES.classPropertyLanguages, {
    ...options,
    perClass: options?.perClass ?? true,
  });
}

// Domain-specific executor stages

export function uriSpaces(
  uriSpaceMap: ReadonlyMap<string, readonly Quad[]>,
  options?: VoidStageOptions & DecoratableStageOptions,
): Promise<Stage> {
  return createVoidStage(VOID_STAGE_NAMES.objectUriSpace, {
    ...options,
    builtIn: (inner) => new UriSpaceExecutor(inner, uriSpaceMap),
  });
}

export interface DetectVocabulariesOptions extends VoidStageOptions {
  /** Additional vocabulary namespace URIs to detect beyond the built-in defaults. */
  vocabularies?: readonly string[];
}

export function detectVocabularies(
  options?: DetectVocabulariesOptions & DecoratableStageOptions,
): Promise<Stage> {
  return createVoidStage(VOID_STAGE_NAMES.entityProperties, {
    ...options,
    builtIn: (inner) =>
      new VocabularyExecutor(
        inner,
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
    decorators,
    ...stageOptions
  } = options ?? {};

  // Single ordered source of truth for the bundle: each entry pairs a stage
  // name with the factory that builds it. The decorator is routed by the same
  // `name` the factory is bound to, so a consumer decorator can never reach the
  // wrong stage. Order matters — `classPartition` warms the `?s a ?class` cache
  // before the per-class stages run.
  const builders: {
    name: VoidStageName;
    build: (
      perStageOptions: PerClassVoidStageOptions & DecoratableStageOptions,
    ) => Promise<Stage>;
  }[] = [
    // Global counting stages.
    { name: VOID_STAGE_NAMES.subjects, build: countSubjects },
    { name: VOID_STAGE_NAMES.properties, build: countProperties },
    { name: VOID_STAGE_NAMES.objectLiterals, build: countObjectLiterals },
    { name: VOID_STAGE_NAMES.objectUris, build: countObjectUris },
    { name: VOID_STAGE_NAMES.datatypes, build: countDatatypes },
    { name: VOID_STAGE_NAMES.triples, build: countTriples },

    // Cache warming — must precede per-class stages.
    { name: VOID_STAGE_NAMES.classPartition, build: classPartitions },

    // Per-class stages.
    {
      name: VOID_STAGE_NAMES.classPropertiesSubjects,
      build: classPropertySubjects,
    },
    {
      name: VOID_STAGE_NAMES.classPropertiesObjects,
      build: classPropertyObjects,
    },
    { name: VOID_STAGE_NAMES.classPropertyDatatypes, build: perClassDatatypes },
    {
      name: VOID_STAGE_NAMES.classPropertyObjectClasses,
      build: perClassObjectClasses,
    },
    {
      name: VOID_STAGE_NAMES.classPropertyLanguages,
      build: perClassLanguages,
    },

    // Other stages.
    { name: VOID_STAGE_NAMES.licenses, build: detectLicenses },
    {
      name: VOID_STAGE_NAMES.entityProperties,
      build: (perStageOptions) =>
        detectVocabularies({ ...perStageOptions, vocabularies }),
    },
    { name: VOID_STAGE_NAMES.subjectUriSpace, build: subjectUriSpaces },
    ...(uriSpaceMap
      ? [
          {
            name: VOID_STAGE_NAMES.objectUriSpace,
            build: (perStageOptions: DecoratableStageOptions) =>
              uriSpaces(uriSpaceMap, perStageOptions),
          },
        ]
      : []),
  ];

  return Promise.all(
    builders.map(({ name, build }) =>
      build({ ...stageOptions, decorate: decorators?.[name] }),
    ),
  );
}
