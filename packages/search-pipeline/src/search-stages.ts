import {
  SparqlItemSelector,
  Stage,
  type ItemSelector,
  type StageReaders,
} from '@lde/pipeline';
import { projectRoots, type RootType, type SearchSchema } from '@lde/search';
import type { TypedSearchDocument } from './typed-search-document.js';

/** One root type’s stage in a search pipeline. */
export interface SearchStageType {
  /**
   * The {@link RootType} this stage projects. Must belong to
   * {@link SearchStagesOptions.schema} (matched by `class`); the stage projects
   * with the schema’s own declaration object, so `assertTypeInSchema`’s identity
   * check inside {@link projectRoots} always holds. A Reference Type is never a
   * stage: it is reached only through an inline reference, never selected.
   */
  searchType: RootType;
  /**
   * The selector variable that binds this type’s roots – the CONSTRUCT subject
   * the batch is complete for. Must **not** be `dataset`: `?dataset` is
   * substituted with the dataset IRI by the SPARQL reader, so a root bound to it
   * would never reach the projection. {@link selectByClass} defaults to `root`.
   */
  rootVariable: string;
  /**
   * Selects this type’s roots, one binding of {@link rootVariable} per root.
   * Root selection is the deployment’s concern; {@link selectByClass} is a
   * convenience for the object grain, not a default.
   */
  itemSelector: ItemSelector;
  /** Reader(s) that extract each selected root’s quads. */
  readers: StageReaders;
  /**
   * Roots (and so documents) per batch – the memory bound. Under a root-bound
   * selector it moves memory and request count, never output.
   * @default 10
   */
  batchSize?: number;
  /** Maximum concurrent in-flight SPARQL queries for this stage. @default 10 */
  maxConcurrency?: number;
  /**
   * Capacity of the bounded queue funnelling this stage’s projected documents
   * into the write. A projected document is far heavier than a quad, so lower it
   * where documents are large. @default 128
   */
  queueCapacity?: number;
}

/** Options for {@link searchStages}. */
export interface SearchStagesOptions {
  /**
   * The declarative schema driving projection: one {@link SearchType} per root
   * type. Every {@link SearchStageType.searchType} must be a member of it.
   */
  schema: SearchSchema;
  /** One entry per root type to index, each its own stage. */
  types: readonly SearchStageType[];
}

/**
 * Compose one projecting {@link Stage} per root type – the source side of a
 * search pipeline. Each stage selects its own roots, extracts each root’s quads,
 * and projects the root-complete batch into {@link TypedSearchDocument}s
 * ({@link projectRoots} + the `searchType` pair), which the pipeline’s single
 * {@link searchIndexWriter} terminal routes to that type’s collection. Projection
 * happens **inside the batch**, so memory is bounded by `batchSize` roots, never
 * by the dataset
 * ([ADR 13](https://github.com/ldelements/lde/blob/main/docs/decisions/0013-project-inside-the-batch-per-root-type.md)).
 *
 * Wire the result as `new Pipeline<TypedSearchDocument>({ datasetSelector,
 * stages: searchStages(...), writers: searchIndexWriter(...) })` – one terminal,
 * N stages.
 */
export function searchStages(
  options: SearchStagesOptions,
): Stage<TypedSearchDocument>[] {
  const { schema, types } = options;
  return types.map((type) => {
    // Project with the schema’s OWN declaration object, whatever the caller
    // passed: `assertTypeInSchema` (inside `projectRoots`) is an identity check,
    // and re-resolving here makes a class-equal lookalike work too.
    const searchType = schema.get(type.searchType.class);
    if (searchType === undefined) {
      throw new Error(
        `Search type “${type.searchType.name}” (class ${type.searchType.class}) is not in the schema; searchStages projects only types the schema declares.`,
      );
    }
    const { rootVariable } = type;
    return new Stage<TypedSearchDocument>({
      name: searchType.name,
      readers: type.readers,
      itemSelector: type.itemSelector,
      batchSize: type.batchSize,
      maxConcurrency: type.maxConcurrency,
      queueCapacity: type.queueCapacity,
      project: async function* (quads, context) {
        // The batch is root-complete by construction: `context.bindings` are the
        // selector rows the readers ran with, so these are exactly this batch’s
        // roots. Project them, then re-attach the type the stage was built for.
        const roots = context.bindings.map((binding) => {
          const term = binding[rootVariable];
          if (term === undefined) {
            // The selector projected a different variable than the stage reads:
            // a config mismatch. Fail loudly rather than deref `undefined`.
            throw new Error(
              `Stage “${searchType.name}”: selector did not bind ?${rootVariable} – the stage’s rootVariable must match the selector’s projected variable.`,
            );
          }
          return term.value;
        });
        for await (const document of projectRoots(
          quads,
          roots,
          schema,
          searchType,
        )) {
          yield { searchType, document };
        }
      },
    });
  });
}

/**
 * An {@link ItemSelector} that selects every instance of a root type’s source
 * class: `SELECT ?‹rootVariable› WHERE { ?‹rootVariable› a <class> }`. A
 * convenience for the **object grain**, where {@link RootType.class} really is
 * the source class – **not** a default: root selection is a deployment concern,
 * and three of the Dataset Register’s four catalog types have no source class at
 * all (their entry point – “registered, newest registration, has a title” – is a
 * deployment fact no schema states).
 *
 * `rootVariable` defaults to `root` and must match the stage’s
 * {@link SearchStageType.rootVariable}; it must not be `dataset` (reserved by the
 * SPARQL reader).
 */
export function selectByClass(
  searchType: RootType,
  rootVariable = 'root',
): ItemSelector {
  return new SparqlItemSelector({
    query: `SELECT ?${rootVariable} WHERE { ?${rootVariable} a <${searchType.class}> }`,
  });
}
