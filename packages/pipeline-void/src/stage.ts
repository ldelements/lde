import {
  Stage,
  SparqlConstructReader,
  SparqlItemSelector,
  readQueryFile,
  type AttachedReader,
  type ReaderContext,
  type ItemSelector,
  type QuadTransform,
} from '@lde/pipeline';
import { assertSafeIri } from '@lde/dataset';
import type { Quad } from '@rdfjs/types';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  withVocabularies,
  defaultVocabularies,
} from './vocabularyTransform.js';
import { withUriSpaces } from './uriSpaceTransform.js';
import { substituteMintMarkers } from './partitionIri.js';

const queriesDir = resolve(
  dirname(fileURLToPath(import.meta.url)),
  '..',
  'queries',
);

/**
 * Stable names for every VoID stage, equal to the underlying query filename.
 *
 * Consumers reference these constants – e.g. when routing a transform through
 * {@link VoidStagesOptions.transforms} – instead of hard-coding `.rq`
 * filenames, so internal query names never leak into consumer code.
 */
export const VOID_STAGE_NAMES = {
  subjects: 'subjects.rq',
  properties: 'properties.rq',
  objectLiterals: 'object-literals.rq',
  objectUris: 'object-uris.rq',
  datatypes: 'datatypes.rq',
  triples: 'triples.rq',
  classPartitions: 'class-partition.rq',
  classPropertySubjects: 'class-properties-subjects.rq',
  classPropertyObjects: 'class-properties-objects.rq',
  perClassDatatypes: 'class-property-datatypes.rq',
  perClassObjectClasses: 'class-property-object-classes.rq',
  perClassLanguages: 'class-property-languages.rq',
  licenses: 'licenses.rq',
  vocabularies: 'entity-properties.rq',
  subjectUriSpace: 'subject-uri-space.rq',
  objectUriSpace: 'object-uri-space.rq',
} as const;

/** The name of a VoID stage. @see VOID_STAGE_NAMES */
export type VoidStageName =
  (typeof VOID_STAGE_NAMES)[keyof typeof VOID_STAGE_NAMES];

/** A transform, or transforms, decorating a VoID stage's reader output. */
export type VoidStageTransform =
  | QuadTransform<ReaderContext>
  | QuadTransform<ReaderContext>[];

/**
 * Options for configuring VoID stage execution.
 *
 * Per-request timeouts are configured at the {@link Pipeline} level via
 * `PipelineOptions.timeout`; VoID stages no longer expose their own timeout
 * knob. Kept as a named type so per-class / per-stages option types can
 * extend it as more knobs are added.
 */
export interface VoidStageOptions {
  /**
   * Transform(s) decorating this stage's reader output before the stage
   * merges readers. For a global stage the transform sees the reader's
   * complete output; for a per-class stage it sees one batch – one class at
   * `batchSize: 1`. Built-in transforms (e.g. {@link uriSpaces}) compose
   * with these, built-in first.
   */
  transform?: VoidStageTransform;
}

/**
 * Options for per-class VoID stages that iterate over classes.
 *
 * `batchSize` and `maxConcurrency` control how class bindings are batched
 * and processed concurrently – they have no effect on global (non-per-class) stages.
 */
export interface PerClassVoidStageOptions extends VoidStageOptions {
  /** Maximum number of class bindings per reader call. @default 10 */
  batchSize?: number;
  /** Maximum concurrent in-flight reader batches. @default 10 */
  maxConcurrency?: number;
  /** When true, iterate queries per class using a class selector. @default true */
  perClass?: boolean;
}

/**
 * Options for the {@link voidStages} convenience function.
 *
 * The single-stage `transform` seam is intentionally absent here: a bundle
 * spans many stages, so transforms are routed per stage via
 * {@link VoidStagesOptions.transforms}.
 */
export interface VoidStagesOptions extends Omit<
  PerClassVoidStageOptions,
  'transform'
> {
  /** When provided, includes the object URI space stage using this map. */
  uriSpaces?: ReadonlyMap<string, readonly Quad[]>;
  /** Additional vocabulary namespace URIs to detect beyond the built-in defaults. */
  vocabularies?: readonly string[];
  /**
   * Transforms to attach to bundled stages, keyed by {@link VOID_STAGE_NAMES}.
   *
   * Each transform decorates the reader of the named stage – so a consumer
   * can wrap a stage it never constructs. Where a stage already carries a
   * built-in transform ({@link uriSpaces}, {@link detectVocabularies}), the
   * consumer transform composes after it. An invalid key is a compile error.
   */
  transforms?: Partial<Record<VoidStageName, VoidStageTransform>>;
}

async function createVoidStage(
  filename: VoidStageName,
  options?: {
    transform?: VoidStageTransform;
    perClass?: boolean;
    batchSize?: number;
    maxConcurrency?: number;
    expectsOutput?: boolean;
  },
): Promise<Stage> {
  const query = substituteMintMarkers(
    await readQueryFile(resolve(queriesDir, filename)),
  );
  const reader: AttachedReader = {
    reader: new SparqlConstructReader({ query }),
    transform: options?.transform,
  };

  return new Stage({
    name: filename,
    readers: reader,
    itemSelector: options?.perClass ? classSelector() : undefined,
    batchSize: options?.batchSize,
    maxConcurrency: options?.maxConcurrency,
    expectsOutput: options?.expectsOutput,
  });
}

/** Normalise a {@link VoidStageTransform} to an array. */
function asTransforms(
  transform?: VoidStageTransform,
): QuadTransform<ReaderContext>[] {
  if (transform === undefined) return [];
  return Array.isArray(transform) ? [...transform] : [transform];
}

function classSelector(): ItemSelector {
  return {
    // Forward `options` so the Pipeline’s per-dataset TimeoutPolicy
    // reaches the inner SparqlItemSelector – without this the adaptive
    // budget is silently bypassed for class selection.
    select: (distribution, batchSize, options) => {
      const subjectFilter = distribution.subjectFilter ?? '';
      let fromClause = '';
      if (distribution.namedGraph) {
        assertSafeIri(distribution.namedGraph);
        fromClause = `FROM <${distribution.namedGraph}>`;
      }
      // Exclude blank-node classes at the endpoint: the selector would drop
      // them client-side anyway (no stable identity), but only after fetching
      // them.
      const selectorQuery = [
        'SELECT DISTINCT ?class',
        fromClause,
        `WHERE { ${subjectFilter} ?s a ?class . FILTER(!isBlank(?class)) }`,
        'LIMIT 1000',
      ].join('\n');

      return new SparqlItemSelector({
        query: selectorQuery,
      }).select(distribution, batchSize, options);
    },
  };
}

// Global stages

export function subjectUriSpaces(options?: VoidStageOptions): Promise<Stage> {
  return createVoidStage(VOID_STAGE_NAMES.subjectUriSpace, options);
}

export function classPartitions(options?: VoidStageOptions): Promise<Stage> {
  return createVoidStage(VOID_STAGE_NAMES.classPartitions, options);
}

// Scalar-aggregate counts: each query is a single COUNT with no GROUP BY/HAVING,
// so it always returns exactly one row. Zero output therefore means the endpoint
// truncated the response, so they set `expectsOutput` to fail (and trigger the
// reactive dump fallback) rather than store a missing count.

export function countObjectLiterals(
  options?: VoidStageOptions,
): Promise<Stage> {
  return createVoidStage(VOID_STAGE_NAMES.objectLiterals, {
    ...options,
    expectsOutput: true,
  });
}

export function countObjectUris(options?: VoidStageOptions): Promise<Stage> {
  return createVoidStage(VOID_STAGE_NAMES.objectUris, {
    ...options,
    expectsOutput: true,
  });
}

export function countProperties(options?: VoidStageOptions): Promise<Stage> {
  return createVoidStage(VOID_STAGE_NAMES.properties, {
    ...options,
    expectsOutput: true,
  });
}

export function countSubjects(options?: VoidStageOptions): Promise<Stage> {
  return createVoidStage(VOID_STAGE_NAMES.subjects, {
    ...options,
    expectsOutput: true,
  });
}

export function countTriples(options?: VoidStageOptions): Promise<Stage> {
  return createVoidStage(VOID_STAGE_NAMES.triples, {
    ...options,
    expectsOutput: true,
  });
}

export function classPropertySubjects(
  options?: PerClassVoidStageOptions,
): Promise<Stage> {
  return createVoidStage(VOID_STAGE_NAMES.classPropertySubjects, {
    ...options,
    perClass: options?.perClass ?? true,
  });
}

export function classPropertyObjects(
  options?: PerClassVoidStageOptions,
): Promise<Stage> {
  return createVoidStage(VOID_STAGE_NAMES.classPropertyObjects, {
    ...options,
    perClass: options?.perClass ?? true,
  });
}

export function countDatatypes(options?: VoidStageOptions): Promise<Stage> {
  // No expectsOutput: unlike the other counts, this query joins the scalar
  // count with a `SELECT DISTINCT ?datatype` group, so a dataset with no
  // literals yields zero rows – a legitimately empty result, not a truncation.
  return createVoidStage(VOID_STAGE_NAMES.datatypes, options);
}

export function detectLicenses(options?: VoidStageOptions): Promise<Stage> {
  return createVoidStage(VOID_STAGE_NAMES.licenses, options);
}

// Per-class stages

export function perClassObjectClasses(
  options?: PerClassVoidStageOptions,
): Promise<Stage> {
  return createVoidStage(VOID_STAGE_NAMES.perClassObjectClasses, {
    ...options,
    perClass: options?.perClass ?? true,
  });
}

export function perClassDatatypes(
  options?: PerClassVoidStageOptions,
): Promise<Stage> {
  return createVoidStage(VOID_STAGE_NAMES.perClassDatatypes, {
    ...options,
    perClass: options?.perClass ?? true,
  });
}

export function perClassLanguages(
  options?: PerClassVoidStageOptions,
): Promise<Stage> {
  return createVoidStage(VOID_STAGE_NAMES.perClassLanguages, {
    ...options,
    perClass: options?.perClass ?? true,
  });
}

// Stages with a built-in transform

export function uriSpaces(
  uriSpaceMap: ReadonlyMap<string, readonly Quad[]>,
  options?: VoidStageOptions,
): Promise<Stage> {
  return createVoidStage(VOID_STAGE_NAMES.objectUriSpace, {
    transform: [
      withUriSpaces(uriSpaceMap),
      ...asTransforms(options?.transform),
    ],
  });
}

export interface DetectVocabulariesOptions extends VoidStageOptions {
  /** Additional vocabulary namespace URIs to detect beyond the built-in defaults. */
  vocabularies?: readonly string[];
}

export function detectVocabularies(
  options?: DetectVocabulariesOptions,
): Promise<Stage> {
  const { vocabularies, transform } = options ?? {};
  const allVocabularies = vocabularies
    ? [...defaultVocabularies, ...vocabularies]
    : undefined;
  return createVoidStage(VOID_STAGE_NAMES.vocabularies, {
    transform: [withVocabularies(allVocabularies), ...asTransforms(transform)],
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
    transforms,
    ...stageOptions
  } = options ?? {};

  // Merge the shared per-stage options with the transform routed to a stage.
  const withTransform = (name: VoidStageName) => ({
    ...stageOptions,
    transform: transforms?.[name],
  });

  return Promise.all([
    // Global counting stages.
    countSubjects(withTransform(VOID_STAGE_NAMES.subjects)),
    countProperties(withTransform(VOID_STAGE_NAMES.properties)),
    countObjectLiterals(withTransform(VOID_STAGE_NAMES.objectLiterals)),
    countObjectUris(withTransform(VOID_STAGE_NAMES.objectUris)),
    countDatatypes(withTransform(VOID_STAGE_NAMES.datatypes)),
    countTriples(withTransform(VOID_STAGE_NAMES.triples)),

    // Cache warming – must precede per-class stages.
    classPartitions(withTransform(VOID_STAGE_NAMES.classPartitions)),

    // Per-class stages.
    classPropertySubjects(
      withTransform(VOID_STAGE_NAMES.classPropertySubjects),
    ),
    classPropertyObjects(withTransform(VOID_STAGE_NAMES.classPropertyObjects)),
    perClassDatatypes(withTransform(VOID_STAGE_NAMES.perClassDatatypes)),
    perClassObjectClasses(
      withTransform(VOID_STAGE_NAMES.perClassObjectClasses),
    ),
    perClassLanguages(withTransform(VOID_STAGE_NAMES.perClassLanguages)),

    // Other stages.
    detectLicenses(withTransform(VOID_STAGE_NAMES.licenses)),
    detectVocabularies({
      ...withTransform(VOID_STAGE_NAMES.vocabularies),
      vocabularies,
    }),
    subjectUriSpaces(withTransform(VOID_STAGE_NAMES.subjectUriSpace)),
    ...(uriSpaceMap
      ? [uriSpaces(uriSpaceMap, withTransform(VOID_STAGE_NAMES.objectUriSpace))]
      : []),
  ]);
}
