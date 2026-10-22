import { Distribution, type Dataset } from '@lde/dataset';
import {
  SparqlConstructReader,
  SparqlItemSelector,
  Stage,
  type AttachedReader,
  type ItemSelector,
  type QuadTransform,
  type ReaderContext,
  type StageOptions,
  type StageReaders,
} from '@lde/pipeline';
import {
  projectRoots,
  type RootType,
  type SearchDocument,
  type SearchSchema,
} from '@lde/search';
import { extractionQueryString } from './extraction.js';
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
   * the batch is complete for. Must **not** be one of
   * `DATASET_BINDING_VARIABLES` (`dataset`, `datasetPublisher`, …): the item
   * selector and SPARQL reader bind those per dataset, so a root bound to one
   * would collide with that binding and never reach the projection.
   * {@link selectByClass} defaults to `root`.
   */
  rootVariable: string;
  /**
   * Selects this type’s roots, one binding of {@link rootVariable} per root.
   * Root selection is the deployment’s concern; {@link selectByClass} is a
   * convenience for the object grain, not a default.
   */
  itemSelector: ItemSelector;
  /**
   * Reader(s) that extract each selected root’s quads. Defaults to a single
   * {@link SparqlConstructReader} running the **Extraction** CONSTRUCT generated
   * from `searchType` ({@link extractionQuery}), with `rootVariable` as the free
   * subject the batch’s roots bind to – the schema-derived reader the projection
   * is guaranteed to agree with (they share the {@link irAlias} convention).
   * Supply your own only to read from a non-SPARQL source or merge several
   * readers; to enrich the default reader’s quads, use {@link transform}.
   */
  readers?: StageReaders;
  /**
   * {@link QuadTransform}(s) attached to the **default** reader – the usual way
   * to add behaviour to this stage: correct the data, mint a quad the source
   * does not ship, drop one it should not.
   *
   * Attaching here rather than building the reader yourself is what keeps the
   * reader’s `subjectVariable` and this stage’s {@link rootVariable} in
   * agreement: nothing cross-checks them, and a mismatch extracts nothing.
   * Mutually exclusive with {@link readers} – a caller supplying its own
   * reader(s) attaches transforms to them directly ({@link AttachedReader}),
   * since only that caller knows which of several readers each belongs to.
   *
   * A field a transform fills must still declare a `path`: projection skips a
   * field with neither a `path` nor a `derive`, so a transform-minted IR Alias
   * is otherwise never read.
   */
  transform?: QuadTransform<ReaderContext> | QuadTransform<ReaderContext>[];
  /**
   * Where this type’s stage reads, when that is not the dataset’s own
   * distribution – see {@link StageOptions.sourceFor}. {@link registrySource}
   * builds the one that matters here: a root type described by the **dataset
   * registry** rather than by the dataset’s data.
   */
  sourceFor?: StageOptions<TypedSearchDocument>['sourceFor'];
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
 * A root type whose `class` is `dcat:Dataset` describes the dataset being
 * indexed: its stage runs first, and the document it projects for the dataset
 * itself – the one whose `id` is the dataset IRI – reaches every other stage’s
 * projection as `ProjectionContext.datasetDocument`, so a `derive` can copy a
 * field of the dataset onto each document.
 *
 * Wire the result as `new Pipeline<TypedSearchDocument>({ datasetSelector,
 * stages: searchStages(...), writers: searchIndexWriter(...) })` – one terminal,
 * N stages.
 */
export function searchStages(
  options: SearchStagesOptions,
): Stage<TypedSearchDocument>[] {
  const { schema, types } = options;
  // The schema holds one root type per class, so at most one stage matches.
  const isDatasetType = (type: SearchStageType) =>
    type.searchType.class === DCAT_DATASET;
  // The dataset being indexed and its own projected document, for the stages
  // that run after its type’s. The pipeline processes datasets one at a time,
  // so one slot holds one document, never one per dataset; it is read only for
  // the dataset object it was written for.
  let current: { dataset: Dataset; document: SearchDocument } | undefined;
  // A dataset’s stages run one after another, in this order: the dataset
  // type’s stage first, so its document is there for every other stage.
  const ordered = [
    ...types.filter(isDatasetType),
    ...types.filter((type) => !isDatasetType(type)),
  ];
  return ordered.map((type) => {
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
    const isDatasetStage = isDatasetType(type);
    if (type.readers !== undefined && type.transform !== undefined) {
      // Which of the caller’s readers the transform belongs to is knowable only
      // to that caller, so guessing (all of them? the first?) would be a silent
      // wrong answer. Attach it as an AttachedReader instead.
      throw new Error(
        `Search type “${searchType.name}”: “transform” attaches to the default reader, so it cannot be combined with “readers” – attach the transform to your own reader instead ({ reader, transform }).`,
      );
    }
    // Default to the Extraction CONSTRUCT generated from the schema, its subject
    // left free for the batch’s VALUES injection. The reader and the projection
    // then agree by construction: both key off the same IR Aliases – which is
    // also why an attached transform never has to restate the subject variable.
    const readers: StageReaders =
      type.readers ??
      ({
        reader: new SparqlConstructReader({
          query: extractionQueryString(searchType, schema, {
            subjectVariable: rootVariable,
          }),
        }),
        transform: type.transform,
      } satisfies AttachedReader);
    return new Stage<TypedSearchDocument>({
      name: searchType.name,
      readers,
      itemSelector: type.itemSelector,
      sourceFor: type.sourceFor,
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
        // The dataset the batch came from is what a `from: 'dataset'` field is
        // declared over, and what a `derive` reads to relate a projected value
        // to its provenance. The stage is where it is known: the writer sees it
        // only after projection, which is too late for either.
        // The same `iri.toString()` the writer’s provenance bookkeeping and
        // `selectedSources()` use, so a declared field, the membership sweep
        // and the selection all compare one spelling of the IRI.
        const datasetIri = context.dataset.iri.toString();
        for await (const document of projectRoots(
          quads,
          roots,
          schema,
          searchType,
          {
            dataset: datasetIri,
            // Only for other types: the dataset type’s own batches would
            // otherwise see it or not depending on which batch ran first.
            datasetDocument:
              !isDatasetStage && current?.dataset === context.dataset
                ? current.document
                : undefined,
            // Tallied by the pipeline and reported when the dataset completes.
            onUnreadable: ({ field, id, value }) =>
              context.valueUnread(searchType.name, field, { id, value }),
          },
        )) {
          if (isDatasetStage && document.id === datasetIri) {
            current = { dataset: context.dataset, document };
          }
          yield { searchType, document };
        }
      },
    });
  });
}

/**
 * An {@link ItemSelector} that selects every instance of a root type’s source
 * class:
 * `SELECT DISTINCT ?‹rootVariable› WHERE { ?‹rootVariable› a <class> FILTER(!isBlank(?‹rootVariable›)) }`.
 * A convenience for the **object grain**, where {@link RootType.class} really is
 * the source class – **not** a default: root selection is a deployment concern,
 * and three of the Dataset Register’s four catalog types have no source class at
 * all (their entry point – “registered, newest registration, has a title” – is a
 * deployment fact no schema states).
 *
 * **Blank-node subjects are excluded** (`FILTER(!isBlank(?‹rootVariable›))`): a
 * blank node has no stable document key, so it can never become a search
 * document – framing skips it. Excluding it at the endpoint keeps result pages
 * full, so pagination walks the whole class instead of stopping at the first
 * page a client-side drop would leave short.
 *
 * `rootVariable` defaults to `root` and must match the stage’s
 * {@link SearchStageType.rootVariable}; it must not be `dataset` (reserved by the
 * SPARQL reader).
 *
 * `pattern`, a SPARQL graph pattern over `?‹rootVariable›`, restricts the
 * selection to the instances that also match it, e.g.
 * `?root <https://schema.org/about> <http://vocab.getty.edu/aat/300000000>`.
 * The reader injects the selected roots into the extraction, so a root the
 * pattern leaves out is never extracted, projected or written. The query
 * declares no prefixes, so write IRIs in full.
 *
 * The pattern is its own group, so a `UNION` of complete groups or a trailing
 * comment stays under the class constraint and the blank-node filter. The
 * pattern is spliced in as text, though: one with unbalanced braces can close
 * the group itself. It must mention `?‹rootVariable›` – one over another
 * variable joins nothing to the root, so it would restrict nothing – and that
 * is checked by name only, so a mention inside `OPTIONAL` or a comment passes.
 * A pattern without the variable, or one that does not parse, throws here.
 */
export function selectByClass(
  searchType: RootType,
  rootVariable = 'root',
  pattern?: string,
): ItemSelector {
  if (
    pattern !== undefined &&
    !new RegExp(`[?$]${rootVariable}\\b`).test(pattern)
  ) {
    throw new Error(`The pattern must constrain ?${rootVariable}.`);
  }
  const restriction = pattern === undefined ? '' : `{\n${pattern}\n}`;
  return new SparqlItemSelector({
    query: `SELECT DISTINCT ?${rootVariable} WHERE { ?${rootVariable} a <${searchType.class}> . ${restriction} FILTER(!isBlank(?${rootVariable})) }`,
  });
}

/**
 * A {@link SearchStageType.sourceFor} that reads a root type from the **dataset
 * registry** instead of from the dataset’s own data – the endpoint fixed,
 * scoped to the graph the dataset in hand names.
 *
 * A dataset’s description is governed by a different application profile from
 * the objects it contains, and it lives in the register, not in the
 * distribution: registering a dataset *is* submitting a description, so the
 * register is the one source that covers every dataset a pipeline can select.
 * Nothing obliges a publisher to ship a description of the dataset in its own
 * dump.
 *
 * The graph scoping is what keeps the stage per-dataset. A register holds every
 * registration, so an unscoped stage would index the whole catalogue for each
 * dataset processed; scoped, each pass sees exactly the one registration – and
 * the roots a `selectByClass` finds inside that graph are that dataset’s own.
 * It presumes the register names each registration’s graph after the dataset
 * IRI, which is how a DCAT register that crawls per registration stores it (the
 * NDE Dataset Register does so for every registration it holds).
 *
 * A dataset identified by a `file:` URL, as `Dataset.localFile` makes it,
 * has no registration, so it keeps reading its own data: whatever the file says
 * about itself is all there is to index. A registered dataset whose data happens
 * to be a local file still reads its description from the register.
 *
 * Routing is deployment topology, deliberately kept out of the
 * {@link SearchType}: a type is defined by its `class`, not by where its
 * triples come from, so the same declaration serves a deployment that sources
 * it differently.
 *
 * ```ts
 * searchStages({
 *   schema,
 *   types: [...schema.values()].map((searchType) => ({
 *     searchType,
 *     rootVariable: 'root',
 *     itemSelector: selectByClass(searchType),
 *     sourceFor: registryTypeNames.has(searchType.name)
 *       ? registrySource(registryEndpoint)
 *       : undefined,
 *   })),
 * });
 * ```
 */
export function registrySource(
  endpoint: URL,
): NonNullable<SearchStageType['sourceFor']> {
  return (dataset, distribution) =>
    dataset.iri.protocol === 'file:'
      ? distribution
      : Distribution.sparql(endpoint, dataset.iri.toString());
}

/** The class of a root type that describes the dataset being indexed. */
const DCAT_DATASET = 'http://www.w3.org/ns/dcat#Dataset';
