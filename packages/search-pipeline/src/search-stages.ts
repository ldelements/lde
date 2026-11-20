import type { NamedNode, Quad, Term } from '@rdfjs/types';
import { DataFactory } from 'n3';
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
  type ReferenceType,
  type RootType,
  type SearchDocument,
  type SearchField,
  type SearchSchema,
  type SearchType,
} from '@lde/search';
import {
  endpointFieldOf,
  facetMatchesLabels,
  irAlias,
  localLookupTargetsOf,
  physicalFields,
  isInlineReference,
  referencedTargetsOf,
  referenceTypeNamed,
} from '@lde/search/adapter';
import { extractionQueryString, referentHopFields } from './extraction.js';
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
   *
   * **It also runs on this type’s referents in other stages.** Where another
   * type’s `searchable` reference names this type as its target, that stage
   * hands the transform(s) each referent its batch read – the referent’s key
   * and label field under this type’s IR Aliases, and nothing else – so the
   * reference is searched by the labels this type’s documents get. A transform
   * must therefore cope with a node carrying only those two fields, once per
   * referring batch. A reference from this type to itself gets no separate
   * pass: this transform already sees its referents’ quads in the batch.
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
   *
   * Each batch is one Extraction CONSTRUCT, whose planning costs the same
   * however many roots it binds, so larger batches finish a type sooner. A
   * QLever import of 17574 roots ran 5.5 times faster at 100 roots per batch
   * than at 10; past 100 the query grows faster than it saves. A live endpoint
   * shared with other users keeps 10.
   *
   * @default { endpoint: 10, imported: 100 }
   */
  batchSize?: StageOptions<TypedSearchDocument>['batchSize'];
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
 * Before projection, a stage passes the referents of its `searchable`
 * references through their target type’s
 * {@link SearchStageType.transform transform(s)}, so a reference is searched
 * by the labels the target’s documents get. A stage with its own `readers`
 * gets no such pass.
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
  // Each type’s transforms, for the referring stages to apply to its
  // referents. A type with its own readers has none here: `transform`
  // attaches to the default reader only.
  const transformsByClass = new Map(
    types.flatMap((type) =>
      type.transform === undefined
        ? []
        : // By class, as the schema resolves a class-equal lookalike.
          [[type.searchType.class, [type.transform].flat()] as const],
    ),
  );
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
        transform: [
          type.transform ?? [],
          referentTransforms(searchType, schema, transformsByClass) ?? [],
        ].flat(),
      } satisfies AttachedReader);
    return new Stage<TypedSearchDocument>({
      name: searchType.name,
      readers,
      itemSelector: type.itemSelector,
      sourceFor: type.sourceFor,
      batchSize: type.batchSize ?? defaultBatchSize,
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
 * `SELECT DISTINCT ?‹rootVariable› WHERE { ?‹rootVariable› a <class> FILTER(!isBlank(?‹rootVariable›)) } ORDER BY ?‹rootVariable›`.
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
 * **The roots are ordered** (`ORDER BY ?‹rootVariable›`): the selector pages with
 * `LIMIT`/`OFFSET`, and without a total order an endpoint may answer each page
 * in a different order, skipping or repeating roots between pages. The order
 * holds the pages together only while the data does not change during the
 * selection: a root added or removed before the current offset shifts every
 * later page by one.
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
    query: `SELECT DISTINCT ?${rootVariable} WHERE { ?${rootVariable} a <${searchType.class}> . ${restriction} FILTER(!isBlank(?${rootVariable})) } ORDER BY ?${rootVariable}`,
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

/** {@link SearchStageType.batchSize} when the type sets none. */
export const defaultBatchSize = { endpoint: 10, imported: 100 } as const;

/**
 * A transform passing each referent of the type’s `searchable` references –
 * its inline referents’ included – and of its lookups declaring presence
 * leaves, through its target type’s transforms: the
 * quads the extraction read off the referent ({@link referentHopFields}) go
 * in, and what the target’s transforms make of them comes back in their place.
 * A lookup’s referent named by IRI alone is seeded for its presence leaves,
 * through the type’s own transforms too where the lookup names its own type.
 * `undefined` where no such reference names a target with transforms.
 *
 * The batch is buffered to find the referents, so memory stays bounded by the
 * stage’s `batchSize`.
 */
function referentTransforms(
  searchType: RootType,
  schema: SearchSchema,
  transformsByClass: ReadonlyMap<
    string,
    readonly QuadTransform<ReaderContext>[]
  >,
): QuadTransform<ReaderContext> | undefined {
  // Per target with transforms other than the type itself: the reference
  // fields naming it, and the aliases its referents carry. A target’s aliases
  // are its own, so no quad belongs to two targets.
  const routes = new Map<
    RootType,
    { fields: Set<string>; aliases: Set<string> }
  >();
  // Per reference counting presence leaves: the one target (`searchSchema`
  // refuses several) its referents named by IRI alone are seeded through.
  const countedTargetByField = new Map<string, RootType>();
  for (const { alias, field, root } of describedReferences(
    searchType,
    schema,
    true,
  )) {
    for (const target of referencedTargetsOf(field, schema)) {
      if (transformsByClass.get(target.class) === undefined) {
        continue;
      }
      if (physicalFields(field).leafExists.length > 0) {
        countedTargetByField.set(alias, target);
      }
      // A reference to its own type: the type’s transform saw the batch, its
      // referents’ quads included.
      if (target === searchType) {
        continue;
      }
      const route = routes.get(target) ?? {
        fields: new Set<string>(),
        aliases: new Set<string>(),
      };
      route.fields.add(alias);
      for (const hopField of referentHopFields(field, target, schema, root)) {
        route.aliases.add(irAlias(target, hopField));
      }
      routes.set(target, route);
    }
  }
  if (routes.size === 0 && countedTargetByField.size === 0) {
    return undefined;
  }
  const targetsByField = new Map<string, RootType[]>();
  const targetByAlias = new Map<string, RootType>();
  for (const [target, { fields, aliases }] of routes) {
    for (const field of fields) {
      targetsByField.set(field, [...(targetsByField.get(field) ?? []), target]);
    }
    for (const alias of aliases) {
      targetByAlias.set(alias, target);
    }
  }
  return async function* referentTransforms(quads, context) {
    const batch: Quad[] = [];
    // Every node the batch states anything of.
    const subjects = new Set<string>();
    // Each target’s referents in this batch: the objects of the references
    // naming it – and, by IRI, the ones a presence leaf is counted for.
    const referents = new Map<RootType, Set<string>>();
    const counted = new Map<RootType, Map<string, NamedNode>>();
    for await (const quad of quads) {
      batch.push(quad);
      subjects.add(termKey(quad.subject));
      for (const target of targetsByField.get(quad.predicate.value) ?? []) {
        const keys = referents.get(target) ?? new Set<string>();
        keys.add(termKey(quad.object));
        referents.set(target, keys);
      }
      const countedTarget = countedTargetByField.get(quad.predicate.value);
      if (countedTarget !== undefined && quad.object.termType === 'NamedNode') {
        const nodes =
          counted.get(countedTarget) ?? new Map<string, NamedNode>();
        nodes.set(termKey(quad.object), quad.object);
        counted.set(countedTarget, nodes);
      }
    }
    // One pass sorting each quad into its target’s input, or keeping it.
    const inputs = new Map<RootType, Quad[]>();
    for (const quad of batch) {
      const target = targetByAlias.get(quad.predicate.value);
      if (
        target !== undefined &&
        referents.get(target)?.has(termKey(quad.subject))
      ) {
        const input = inputs.get(target) ?? [];
        input.push(quad);
        inputs.set(target, input);
      } else {
        yield quad;
      }
    }
    // A referent a presence leaf is counted for, and that its target’s
    // transforms would see nothing of, enters them as `<referent> rdf:type
    // <class>`: a transform describing a node from its key then sees it. A
    // referent of another target is described by its input; one of the type’s
    // own by anything the batch states of it, which the type’s transforms
    // have already seen. The seed itself is not kept.
    const seeds = new Map<RootType, Set<string>>();
    for (const [target, nodes] of counted) {
      const input = inputs.get(target) ?? [];
      const described =
        target === searchType
          ? subjects
          : new Set(input.map((quad) => termKey(quad.subject)));
      const seeded = new Set<string>();
      for (const [key, node] of nodes) {
        if (!described.has(key)) {
          input.push(
            factory.quad(node, RDF_TYPE, factory.namedNode(target.class)),
          );
          seeded.add(key);
        }
      }
      seeds.set(target, seeded);
      inputs.set(target, input);
    }
    for (const [target, input] of inputs) {
      if (input.length === 0) {
        continue;
      }
      let stream: AsyncIterable<Quad> = streamOf(input);
      for (const transform of transformsByClass.get(
        target.class,
      ) as readonly QuadTransform<ReaderContext>[]) {
        stream = transform(stream, context);
      }
      const seeded = seeds.get(target);
      for await (const quad of stream) {
        if (
          seeded?.has(termKey(quad.subject)) &&
          quad.predicate.equals(RDF_TYPE) &&
          quad.object.value === target.class
        ) {
          continue;
        }
        yield quad;
      }
    }
  };
}

const factory = DataFactory;
const RDF_TYPE = factory.namedNode(
  'http://www.w3.org/1999/02/22-rdf-syntax-ns#type',
);

/** The type’s reference fields whose referents are described – `searchable`
 *  ones, a root type’s own whose facet is searched by label (not a `local` lookup’s, which
 *  reads its referents through the target’s whole declaration), and lookups
 *  declaring presence leaves – each with the IR Alias whose
 *  objects are its referents: its own, and those of the inline referents it
 *  nests. A graph that leaves an edge out points at the endpoint through the
 *  inline field itself, so an endpoint field is reached through both.
 *  `searchSchema` refuses an inline cycle, so the descent ends. */
function describedReferences(
  owner: SearchType,
  schema: SearchSchema,
  root: boolean,
): { alias: string; field: SearchField; root: boolean }[] {
  return owner.fields.flatMap((field) => {
    if (isInlineReference(field)) {
      // Guaranteed declared: `searchSchema` resolves every inline `typeName`.
      const referenceType = referenceTypeNamed(
        schema,
        field.ref.typeName,
      ) as ReferenceType;
      const endpointField = endpointFieldOf(referenceType, field.ref.identity);
      return [
        ...describedReferences(referenceType, schema, false),
        ...(endpointField?.searchable === undefined
          ? []
          : [
              {
                alias: irAlias(owner, field),
                field: endpointField,
                root: false,
              },
            ]),
      ];
    }
    // A reference’s referents are described when it is searched by their
    // labels, a root document’s facet is, or they are counted for a presence
    // leaf.
    return field.kind === 'reference' &&
      (field.searchable !== undefined ||
        (root &&
          facetMatchesLabels(field, schema) &&
          localLookupTargetsOf(field, schema).length === 0) ||
        physicalFields(field).leafExists.length > 0)
      ? [{ alias: irAlias(owner, field), field, root }]
      : [];
  });
}

/** A term’s identity as a string: a blank node never equals an IRI. */
function termKey(term: Term): string {
  return `${term.termType}:${term.value}`;
}

async function* streamOf(quads: readonly Quad[]): AsyncIterable<Quad> {
  yield* quads;
}

/** The class of a root type that describes the dataset being indexed. */
const DCAT_DATASET = 'http://www.w3.org/ns/dcat#Dataset';
