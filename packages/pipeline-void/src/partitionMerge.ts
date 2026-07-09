import {
  canonicalizeIri,
  type BeforeDatasetWriteContext,
  type NamespaceAlias,
  type PipelinePlugin,
  type QuadTransform,
} from '@lde/pipeline';
import type { Quad, Term } from '@rdfjs/types';
import { DataFactory } from 'n3';
import { mintPartitionIri } from './partitionIri.js';

const { namedNode, literal, quad } = DataFactory;

const VOID = 'http://rdfs.org/ns/void#';
const VOID_EXT = 'http://ldf.fi/void-ext#';
const XSD_INTEGER = 'http://www.w3.org/2001/XMLSchema#integer';
const SCHEMA_HTTP = 'http://schema.org/';
const SCHEMA_HTTPS = 'https://schema.org/';

const VOID_CLASS = `${VOID}class`;
const VOID_PROPERTY = `${VOID}property`;
const VOID_ENTITIES = `${VOID}entities`;
const VOID_TRIPLES = `${VOID}triples`;
const VOID_DISTINCT_OBJECTS = `${VOID}distinctObjects`;
const VOID_CLASS_PARTITION = `${VOID}classPartition`;
const VOID_PROPERTY_PARTITION = `${VOID}propertyPartition`;
const VOIDEXT_DATATYPE = `${VOID_EXT}datatype`;
const VOIDEXT_LANGUAGE = `${VOID_EXT}language`;
const VOIDEXT_DATATYPE_PARTITION = `${VOID_EXT}datatypePartition`;
const VOIDEXT_OBJECTCLASS_PARTITION = `${VOID_EXT}objectClassPartition`;
const VOIDEXT_LANGUAGE_PARTITION = `${VOID_EXT}languagePartition`;

/**
 * Integer-literal measures summed when partitions collapse.
 * `void:distinctObjects` is included: a dataset that uses a single schema.org
 * namespace has one variant per class, so there is nothing to combine and the
 * count is unchanged; only a dataset that mixes both namespaces on the same
 * property (rare) sums two distinct-object counts — an over-count we accept
 * rather than optimize for.
 */
const NUMERIC_MEASURES = new Set([
  VOID_ENTITIES,
  VOID_TRIPLES,
  VOID_DISTINCT_OBJECTS,
]);

/** Structural links whose object is a child partition node. */
const CHILD_LINKS = new Set([
  VOID_CLASS_PARTITION,
  VOID_PROPERTY_PARTITION,
  VOIDEXT_DATATYPE_PARTITION,
  VOIDEXT_OBJECTCLASS_PARTITION,
  VOIDEXT_LANGUAGE_PARTITION,
]);

/**
 * Every predicate that describes a partition. A quad with one of these
 * predicates is buffered for merging; every other quad streams through
 * untouched, so the transform's memory is bounded by the VoID summary, not the
 * dataset.
 */
const PARTITION_VOCABULARY = new Set([
  VOID_CLASS,
  VOID_PROPERTY,
  VOIDEXT_DATATYPE,
  VOIDEXT_LANGUAGE,
  // Derived, not re-listed: a measure added to NUMERIC_MEASURES must also be
  // buffered here, or it would stream through un-summed.
  ...NUMERIC_MEASURES,
  ...CHILD_LINKS,
]);

/** `void:class` / `void:property` objects are IRIs subject to canonicalization. */
const CANONICALIZED_OBJECT_PREDICATES = new Set([VOID_CLASS, VOID_PROPERTY]);

/**
 * A {@link QuadTransform} for the {@link PipelinePlugin.beforeDatasetWrite} hook
 * that merges the `void:classPartition` / `void:propertyPartition` subtrees of
 * namespace-alias variants (e.g. `http://schema.org/CreativeWork` and
 * `https://schema.org/CreativeWork`) into one partition per canonical
 * class/property.
 *
 * VoID partitions are keyed by an opaque `MD5(class[, property[, …]])` IRI, so
 * two namespace variants produce two partition nodes that, once the class IRI is
 * canonicalized, describe the same class. Seeing a whole dataset's output at
 * once, this transform re-mints every partition IRI from its **canonical** key
 * components via {@link mintPartitionIri} — the single source of truth the
 * queries' SPARQL minting is also generated from — collapses the duplicates,
 * and sums their numeric measures.
 *
 * It streams: only partition quads are buffered (bounded by the summary — a
 * handful of classes × properties, not the dataset), and every other quad
 * passes straight through.
 *
 * Datasets typically use a single schema.org namespace, so within one dataset
 * there is one variant per class and the transform merely renames and re-keys —
 * `void:distinctObjects` and every count stay exact. A dataset that genuinely
 * mixes both namespaces on the same property collapses the variants by summing,
 * which over-counts shared distinct objects; this is not optimized for.
 *
 * With no aliases configured the transform is a no-op.
 */
export function mergeNamespaceVariants(
  namespaceAliases: readonly NamespaceAlias[],
): QuadTransform<BeforeDatasetWriteContext> {
  if (namespaceAliases.length === 0) {
    return (quads) => quads;
  }
  return async function* (quads, { dataset }) {
    const datasetIri = dataset.iri.toString();
    const partitionQuads: Quad[] = [];
    for await (const q of quads) {
      if (PARTITION_VOCABULARY.has(q.predicate.value)) {
        partitionQuads.push(q);
      } else {
        yield q;
      }
    }
    yield* mergeBuffered(partitionQuads, datasetIri, namespaceAliases);
  };
}

/**
 * A {@link PipelinePlugin} that canonicalizes schema.org namespace variants in
 * the VoID output — rewriting `http://schema.org/` to `https://schema.org/` —
 * _and_ merges the duplicate partition nodes the two variants produced. Runs on
 * the whole dataset's output via {@link PipelinePlugin.beforeDatasetWrite}, so
 * the analysis queries stay unaware of namespace aliases.
 *
 * This does more than a plain namespace rewrite: rewriting the `void:class`
 * objects alone would leave two `void:classPartition` nodes for the same class.
 * For a non-VoID, blanket namespace rewrite (e.g. mapping instance data to an
 * application profile), use `schemaOrgNormalizationPlugin` from `@lde/pipeline`.
 */
export function schemaOrgPartitionMergePlugin(): PipelinePlugin {
  return namespacePartitionMergePlugin([
    { canonical: SCHEMA_HTTPS, alias: SCHEMA_HTTP },
  ]);
}

/**
 * A {@link PipelinePlugin} that canonicalizes the given namespace aliases in the
 * VoID output and merges the duplicate partition nodes their variants produced.
 * Generic form of {@link schemaOrgPartitionMergePlugin}.
 *
 * Required stages: re-keying a datatype/language/object-class partition walks up
 * its `cp → pp → dp` chain, reading `void:class` and `void:property` that
 * `classPartitions` and `classPropertySubjects` emit. Use this plugin with a
 * stage set that includes both (as {@link voidStages} does); without them a
 * void-ext partition cannot be re-keyed and its alias variants ship unmerged.
 */
export function namespacePartitionMergePlugin(
  namespaceAliases: readonly NamespaceAlias[],
): PipelinePlugin {
  return {
    name: 'void-namespace-partition-merge',
    beforeDatasetWrite: mergeNamespaceVariants(namespaceAliases),
  };
}

/** One node's describing quads, indexed for component lookup. */
interface NodeIndex {
  /** For a partition node: the structural predicate linking its parent to it. */
  incomingLink?: { predicate: string; parent: string };
  values: Map<string, Term>;
}

/** A running sum of one numeric measure, keyed by (subject, predicate, graph). */
interface MeasureSum {
  subject: Quad['subject'];
  predicate: Quad['predicate'];
  graph: Quad['graph'];
  datatype: string;
  total: bigint;
}

function* mergeBuffered(
  buffered: readonly Quad[],
  datasetIri: string,
  namespaceAliases: readonly NamespaceAlias[],
): Iterable<Quad> {
  const nodes = indexNodes(buffered);
  const remap = buildRemap(nodes, datasetIri, namespaceAliases);

  const measureSums = new Map<string, MeasureSum>();
  const emitted = new Set<string>();

  for (const original of buffered) {
    const subject = remapTerm(original.subject, remap);
    let object = remapTerm(original.object, remap);
    // Canonicalize a void:class/void:property object only when its own
    // partition node is being re-keyed. The top-level property partitions from
    // entity-properties.rq are never merged (their parent is the dataset, not a
    // class), so they keep the source namespace — consumers can still see which
    // namespace the dataset actually uses (see ADR 7).
    if (remap.has(original.subject.value)) {
      object = canonicalizeObject(
        object,
        original.predicate.value,
        namespaceAliases,
      );
    }
    const rewritten = quad(subject, original.predicate, object, original.graph);

    if (NUMERIC_MEASURES.has(original.predicate.value)) {
      accumulateMeasure(measureSums, rewritten);
      continue;
    }

    const key = quadKey(rewritten);
    if (!emitted.has(key)) {
      emitted.add(key);
      yield rewritten;
    }
  }

  for (const sum of measureSums.values()) {
    yield reconstructMeasure(sum);
  }
}

function indexNodes(buffered: readonly Quad[]): Map<string, NodeIndex> {
  const nodes = new Map<string, NodeIndex>();
  const nodeOf = (value: string): NodeIndex => {
    let node = nodes.get(value);
    if (!node) {
      node = { values: new Map() };
      nodes.set(value, node);
    }
    return node;
  };

  for (const q of buffered) {
    if (
      CHILD_LINKS.has(q.predicate.value) &&
      q.object.termType === 'NamedNode'
    ) {
      nodeOf(q.object.value).incomingLink = {
        predicate: q.predicate.value,
        parent: q.subject.value,
      };
    } else {
      nodeOf(q.subject.value).values.set(q.predicate.value, q.object);
    }
  }
  return nodes;
}

/**
 * Build a raw-IRI → canonical-IRI map for every partition node whose canonical
 * key differs from its current IRI.
 */
function buildRemap(
  nodes: Map<string, NodeIndex>,
  datasetIri: string,
  namespaceAliases: readonly NamespaceAlias[],
): Map<string, string> {
  const remap = new Map<string, string>();
  for (const [iri, node] of nodes) {
    const canonicalIri = canonicalPartitionIri(
      node,
      nodes,
      datasetIri,
      namespaceAliases,
    );
    if (canonicalIri !== undefined && canonicalIri !== iri) {
      remap.set(iri, canonicalIri);
    }
  }
  return remap;
}

/**
 * The canonical partition IRI for a node, or `undefined` if the node is not a
 * partition (no incoming structural link). Replicates the queries' minting:
 * `<dataset>/.well-known/void#<prefix>-<MD5(STR(component)…)>`.
 */
function canonicalPartitionIri(
  node: NodeIndex,
  nodes: Map<string, NodeIndex>,
  datasetIri: string,
  namespaceAliases: readonly NamespaceAlias[],
): string | undefined {
  const link = node.incomingLink;
  if (link === undefined) return undefined;
  const canon = (value: string) => canonicalizeIri(value, namespaceAliases);
  const classOf = (partition: string) =>
    nodes.get(partition)?.values.get(VOID_CLASS)?.value;

  switch (link.predicate) {
    case VOID_CLASS_PARTITION: {
      const klass = node.values.get(VOID_CLASS)?.value;
      return klass
        ? mintPartitionIri(datasetIri, 'class', [canon(klass)])
        : undefined;
    }
    case VOID_PROPERTY_PARTITION: {
      const klass = classOf(link.parent);
      const property = node.values.get(VOID_PROPERTY)?.value;
      return klass && property
        ? mintPartitionIri(datasetIri, 'class-property', [
            canon(klass),
            canon(property),
          ])
        : undefined;
    }
    case VOIDEXT_DATATYPE_PARTITION: {
      const [klass, property] = classProperty(link.parent, nodes);
      const datatype = node.values.get(VOIDEXT_DATATYPE)?.value;
      return klass && property && datatype
        ? mintPartitionIri(datasetIri, 'datatype', [
            canon(klass),
            canon(property),
            datatype,
          ])
        : undefined;
    }
    case VOIDEXT_OBJECTCLASS_PARTITION: {
      const [klass, property] = classProperty(link.parent, nodes);
      const objectClass = node.values.get(VOID_CLASS)?.value;
      return klass && property && objectClass
        ? mintPartitionIri(datasetIri, 'object-class', [
            canon(klass),
            canon(property),
            canon(objectClass),
          ])
        : undefined;
    }
    case VOIDEXT_LANGUAGE_PARTITION: {
      const [klass, property] = classProperty(link.parent, nodes);
      const language = node.values.get(VOIDEXT_LANGUAGE)?.value;
      return klass && property && language !== undefined
        ? mintPartitionIri(datasetIri, 'language', [
            canon(klass),
            canon(property),
            language,
          ])
        : undefined;
    }
    default:
      return undefined;
  }
}

/** The (class, property) of a property partition, following it up to its class partition. */
function classProperty(
  propertyPartition: string,
  nodes: Map<string, NodeIndex>,
): [string | undefined, string | undefined] {
  const node = nodes.get(propertyPartition);
  const property = node?.values.get(VOID_PROPERTY)?.value;
  const classPartition = node?.incomingLink?.parent;
  const klass = classPartition
    ? nodes.get(classPartition)?.values.get(VOID_CLASS)?.value
    : undefined;
  return [klass, property];
}

function remapTerm<T extends Term>(term: T, remap: Map<string, string>): T {
  if (term.termType === 'NamedNode') {
    const canonical = remap.get(term.value);
    if (canonical !== undefined) return namedNode(canonical) as unknown as T;
  }
  return term;
}

function canonicalizeObject<T extends Term>(
  object: T,
  predicate: string,
  namespaceAliases: readonly NamespaceAlias[],
): T {
  if (
    CANONICALIZED_OBJECT_PREDICATES.has(predicate) &&
    object.termType === 'NamedNode'
  ) {
    const canonical = canonicalizeIri(object.value, namespaceAliases);
    if (canonical !== object.value) return namedNode(canonical) as unknown as T;
  }
  return object;
}

function accumulateMeasure(sums: Map<string, MeasureSum>, measure: Quad): void {
  const key = `${measure.subject.value} ${measure.predicate.value} ${measure.graph.value}`;
  const existing = sums.get(key);
  if (existing === undefined) {
    sums.set(key, {
      subject: measure.subject,
      predicate: measure.predicate,
      graph: measure.graph,
      datatype:
        measure.object.termType === 'Literal'
          ? measure.object.datatype.value
          : XSD_INTEGER,
      total: parseInteger(measure.object),
    });
  } else {
    existing.total += parseInteger(measure.object);
  }
}

function parseInteger(object: Term): bigint {
  if (object.termType === 'Literal' && /^[+-]?\d+$/.test(object.value)) {
    return BigInt(object.value);
  }
  return 0n;
}

function reconstructMeasure(sum: MeasureSum): Quad {
  return quad(
    sum.subject,
    sum.predicate,
    literal(sum.total.toString(), namedNode(sum.datatype)),
    sum.graph,
  );
}

function quadKey(q: Quad): string {
  return [
    q.subject.value,
    q.predicate.value,
    termKey(q.object),
    q.graph.value,
  ].join(' ');
}

function termKey(term: Term): string {
  if (term.termType === 'Literal') {
    return `"${term.value}"^^${term.datatype.value}@${term.language}`;
  }
  return term.value;
}
