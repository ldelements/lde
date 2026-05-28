import {
  ConstantTimeoutPolicy,
  Stage,
  SparqlConstructExecutor,
  SparqlItemSelector,
  type ItemSelector,
  type StageOptions,
  type ValidationReport,
  type ValidationResult,
  type Validator,
} from '@lde/pipeline';
import { assertSafeIri, type Dataset } from '@lde/dataset';
import type { NamedNode, Quad } from '@rdfjs/types';
import { DataFactory } from 'n3';
import { extractTargetShapes, type TargetShape } from './pathExtractor.js';

const { namedNode, quad } = DataFactory;

type OnInvalid = NonNullable<StageOptions['validation']>['onInvalid'];

/**
 * Declares that two namespaces should be treated as equivalent when
 * sampling and validating, working around vocabularies that publish under
 * both HTTP and HTTPS variants of the same IRI (notably schema.org).
 *
 * The sampler accepts subjects typed under the {@link alias} namespace in
 * addition to the SHACL `sh:targetClass` IRI under {@link canonical}, and
 * rewrites alias-namespace IRIs to canonical ones in the sampled quads
 * before validation so SHACL `sh:targetClass` and `sh:path` patterns
 * match.
 */
export interface NamespaceAlias {
  /**
   * The namespace declared in the SHACL shapes file (e.g.
   * `https://schema.org/`).
   */
  canonical: string;
  /**
   * The equivalent namespace that may appear in source data (e.g.
   * `http://schema.org/`).
   */
  alias: string;
}

/** Options for {@link shaclSampleStages}. */
export interface ShaclSampleStagesOptions {
  /** URL or local path to the SHACL shapes file. */
  shapesFile: string;
  /**
   * Number of top-level resources to sample per `sh:targetClass`.
   * @default 50
   */
  samplesPerClass?: number;
  /**
   * SPARQL query timeout in milliseconds.
   * @default 60000
   */
  timeout?: number;
  /**
   * Maximum number of sampled subjects per executor call. Defaults to
   * {@link samplesPerClass} so the whole sample fits in one CONSTRUCT
   * round-trip; lower to spread work across multiple parallel queries.
   */
  batchSize?: number;
  /**
   * Maximum concurrent in-flight executor batches per stage. @default 10
   */
  maxConcurrency?: number;
  /**
   * Validator attached to every generated stage. Typically a
   * {@link https://www.npmjs.com/package/@lde/pipeline-shacl-validator ShaclValidator}
   * configured with the same {@link shapesFile}.
   */
  validator?: Validator;
  /**
   * Behaviour when a sampled batch fails validation. Only used when
   * {@link validator} is set.
   * @default 'write'
   */
  onInvalid?: OnInvalid;
  /**
   * Namespace pairs to treat as equivalent when matching `sh:targetClass`
   * and when handing quads to the validator. For each pair, the sampler
   * broadens its subject-selection SELECT so resources typed under either
   * namespace are picked up, and wraps the configured {@link validator}
   * so alias-namespace IRIs in the sampled quads are rewritten to the
   * canonical form before SHACL evaluates them.
   *
   * Defaults to no aliases. To cover schema.org datasets that publish
   * under both `http://schema.org/` and `https://schema.org/`, pass
   * `[{ canonical: 'https://schema.org/', alias: 'http://schema.org/' }]`.
   */
  namespaceAliases?: NamespaceAlias[];
}

/**
 * Build one sampling {@link Stage} per `sh:targetClass` declared in the SHACL
 * shapes file. Each stage pairs a SELECT-based {@link ItemSelector} that picks
 * N instances of its target class with a CONSTRUCT executor that, for every
 * path chain the SHACL declares (recursively, stopping at leaf constraints
 * or cycles), pulls in the triples reachable along that chain’s terminal
 * node.
 *
 * Pass a {@link Validator} to attach it to every generated stage:
 *
 * ```ts
 * const validator = new ShaclValidator({ shapesFile, reportWriters: [...] });
 * const stages = await shaclSampleStages({ shapesFile, validator });
 * ```
 */
export async function shaclSampleStages(
  options: ShaclSampleStagesOptions,
): Promise<Stage[]> {
  const samplesPerClass = options.samplesPerClass ?? 50;
  const timeout = options.timeout ?? 60_000;
  const batchSize = options.batchSize ?? samplesPerClass;
  const maxConcurrency = options.maxConcurrency;
  const namespaceAliases = options.namespaceAliases ?? [];
  const validation = options.validator
    ? {
        validator: wrapValidatorWithAliasNormalization(
          options.validator,
          namespaceAliases,
        ),
        onInvalid: options.onInvalid ?? 'write',
      }
    : undefined;
  const shapes = await extractTargetShapes(options.shapesFile);

  return shapes.map(
    (shape) =>
      new Stage({
        name: `shacl-sample-${localName(shape.targetClass.value)}`,
        itemSelector: subjectSelector(
          shape.targetClass,
          samplesPerClass,
          namespaceAliases,
        ),
        executors: new SparqlConstructExecutor({
          query: buildSampleQuery(shape),
          timeoutPolicy: new ConstantTimeoutPolicy(timeout),
        }),
        batchSize,
        maxConcurrency,
        validation,
      }),
  );
}

function subjectSelector(
  targetClass: NamedNode,
  limit: number,
  namespaceAliases: NamespaceAlias[],
): ItemSelector {
  assertSafeIri(targetClass.value);
  return {
    select(distribution, batchSize) {
      const query = buildSubjectSelectorQuery({
        targetClass,
        subjectFilter: distribution.subjectFilter,
        namedGraph: distribution.namedGraph,
        namespaceAliases,
      });
      return new SparqlItemSelector({
        query,
        maxResults: limit,
      }).select(distribution, batchSize);
    },
  };
}

/** Options for {@link buildSubjectSelectorQuery}. */
export interface SubjectSelectorQueryOptions {
  /** SHACL `sh:targetClass` to match. */
  targetClass: NamedNode;
  /** Optional extra triple pattern restricting subjects (interpolated verbatim). */
  subjectFilter?: string;
  /** Restrict to a single named graph via `FROM <…>`. */
  namedGraph?: string;
  /** Equivalent namespaces to broaden the type match across. @default [] */
  namespaceAliases?: NamespaceAlias[];
}

export function buildSubjectSelectorQuery({
  targetClass,
  subjectFilter,
  namedGraph,
  namespaceAliases = [],
}: SubjectSelectorQueryOptions): string {
  let fromClause = '';
  if (namedGraph) {
    assertSafeIri(namedGraph);
    fromClause = `FROM <${namedGraph}>`;
  }
  const typePattern = buildTypePattern(targetClass, namespaceAliases);
  return [
    'SELECT DISTINCT ?s',
    fromClause,
    `WHERE { ${subjectFilter ?? ''} ${typePattern} }`,
  ].join('\n');
}

function buildTypePattern(
  targetClass: NamedNode,
  namespaceAliases: NamespaceAlias[],
): string {
  const equivalents = expandTargetClass(targetClass, namespaceAliases);
  for (const iri of equivalents) assertSafeIri(iri);
  if (equivalents.length === 1) {
    return `?s a <${equivalents[0]}> .`;
  }
  const iriList = equivalents.map((iri) => `<${iri}>`).join(', ');
  return `?s a ?type . FILTER(?type IN (${iriList}))`;
}

function expandTargetClass(
  targetClass: NamedNode,
  namespaceAliases: NamespaceAlias[],
): string[] {
  const iri = targetClass.value;
  for (const { canonical, alias } of namespaceAliases) {
    if (iri.startsWith(canonical)) {
      return [iri, alias + iri.slice(canonical.length)];
    }
    if (iri.startsWith(alias)) {
      return [iri, canonical + iri.slice(alias.length)];
    }
  }
  return [iri];
}

export function buildSampleQuery(shape: TargetShape): string {
  for (const chain of shape.pathChains) {
    for (const path of chain) assertSafeIri(path.value);
  }

  const chainBranches = shape.pathChains
    .map(
      (chain) => ` UNION {
    ?s ${chain.map((p) => `<${p.value}>`).join('/')} ?neighbour .
    ?neighbour ?np ?nv .
  }`,
    )
    .join('');

  return `CONSTRUCT {
  ?s ?p ?o .
  ?neighbour ?np ?nv .
}
WHERE {
  {
    ?s ?p ?o .
  }${chainBranches}
}`;
}

/**
 * Decorate a {@link Validator} so every quad it receives has any IRI in an
 * alias namespace rewritten to the corresponding canonical namespace.
 * Without this, SHACL shapes declared under the canonical namespace would
 * silently skip resources whose types and predicates use the alias form,
 * producing vacuously-conformant reports.
 */
export function wrapValidatorWithAliasNormalization(
  inner: Validator,
  namespaceAliases: NamespaceAlias[],
): Validator {
  if (namespaceAliases.length === 0) {
    return inner;
  }
  return {
    validate(quads: Quad[], dataset: Dataset): Promise<ValidationResult> {
      return inner.validate(
        quads.map((q) => normalizeQuad(q, namespaceAliases)),
        dataset,
      );
    },
    report(dataset: Dataset): Promise<ValidationReport> {
      return inner.report(dataset);
    },
  };
}

function normalizeQuad(q: Quad, namespaceAliases: NamespaceAlias[]): Quad {
  const subject = rewriteIfAlias(q.subject, namespaceAliases) ?? q.subject;
  const predicate =
    rewriteIfAlias(q.predicate, namespaceAliases) ?? q.predicate;
  const object = rewriteIfAlias(q.object, namespaceAliases) ?? q.object;
  const graph = rewriteIfAlias(q.graph, namespaceAliases) ?? q.graph;
  if (
    subject === q.subject &&
    predicate === q.predicate &&
    object === q.object &&
    graph === q.graph
  ) {
    return q;
  }
  return quad(subject, predicate, object, graph);
}

function rewriteIfAlias(
  term: Quad['subject' | 'predicate' | 'object' | 'graph'],
  namespaceAliases: NamespaceAlias[],
): NamedNode | undefined {
  if (term.termType !== 'NamedNode') return undefined;
  for (const { canonical, alias } of namespaceAliases) {
    if (term.value.startsWith(alias)) {
      return namedNode(canonical + term.value.slice(alias.length));
    }
  }
  return undefined;
}

function localName(iri: string): string {
  const match = /[#/]([^#/]+)$/.exec(iri);
  return (match?.[1] ?? iri).replace(/[^A-Za-z0-9_-]/g, '_');
}
