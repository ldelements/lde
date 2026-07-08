import {
  canonicalizeIri,
  type NamespaceAlias,
  type QuadTransform,
  type ReaderContext,
} from '@lde/pipeline';
import type { Quad, Term } from '@rdfjs/types';
import { DataFactory } from 'n3';
import { createHash } from 'node:crypto';

const { namedNode, literal, quad } = DataFactory;

const VOID = 'http://rdfs.org/ns/void#';
const VOID_EXT = 'http://ldf.fi/void-ext#';
const XSD_INTEGER = 'http://www.w3.org/2001/XMLSchema#integer';

const VOID_CLASS = `${VOID}class`;
const VOID_PROPERTY = `${VOID}property`;
const VOID_ENTITIES = `${VOID}entities`;
const VOID_TRIPLES = `${VOID}triples`;
const VOID_CLASS_PARTITION = `${VOID}classPartition`;
const VOID_PROPERTY_PARTITION = `${VOID}propertyPartition`;
const VOIDEXT_DATATYPE = `${VOID_EXT}datatype`;
const VOIDEXT_LANGUAGE = `${VOID_EXT}language`;
const VOIDEXT_DATATYPE_PARTITION = `${VOID_EXT}datatypePartition`;
const VOIDEXT_OBJECTCLASS_PARTITION = `${VOID_EXT}objectClassPartition`;
const VOIDEXT_LANGUAGE_PARTITION = `${VOID_EXT}languagePartition`;

// Predicates whose integer-literal objects are summed across merged partitions.
// `void:distinctObjects` is deliberately excluded: distinct-object sets overlap
// across namespace variants, so summing would over-count. It is normalized at
// query time in `class-properties-objects.rq` and never reaches this transform.
const NUMERIC_MEASURES = new Set([VOID_ENTITIES, VOID_TRIPLES]);

/** Structural links whose object is a child partition node. */
const CHILD_LINKS = new Set([
  VOID_CLASS_PARTITION,
  VOID_PROPERTY_PARTITION,
  VOIDEXT_DATATYPE_PARTITION,
  VOIDEXT_OBJECTCLASS_PARTITION,
  VOIDEXT_LANGUAGE_PARTITION,
]);

/** `void:class` / `void:property` objects are IRIs subject to canonicalization. */
const CANONICALIZED_OBJECT_PREDICATES = new Set([VOID_CLASS, VOID_PROPERTY]);

/**
 * A {@link QuadTransform} that merges the `void:classPartition` /
 * `void:propertyPartition` subtrees of namespace-alias variants (e.g.
 * `http://schema.org/CreativeWork` and `https://schema.org/CreativeWork`) into
 * a single partition per canonical class/property.
 *
 * VoID partitions are keyed by an opaque `MD5(class[, property[, …]])` IRI, so
 * two namespace variants yield two partition nodes that both, after
 * canonicalization, describe the same class. This transform re-mints every
 * partition IRI from its **canonical** key components (replicating the queries’
 * SPARQL `MD5(CONCAT(STR(…)))`), collapses the duplicates, and **sums** their
 * numeric measures (`void:entities`, `void:triples`).
 *
 * ## Correctness assumptions
 *
 * Summing pre-aggregated counts is exact only under these assumptions; the
 * queries whose measures cannot be safely summed keep their normalization at
 * query time instead (notably `class-properties-objects.rq`’s
 * `void:distinctObjects`, which this transform never sees):
 *
 * - **Subject/class disjointness** — no resource is typed under two namespace
 *   variants of the same class. Guards the `void:entities` sum on class
 *   partitions and every `void:triples` sum (a doubly-typed resource’s triples
 *   would otherwise count under both variants).
 * - **Predicate-namespace disjointness** — no subject uses two namespace
 *   variants of the same property (e.g. both `http://schema.org/name` and
 *   `https://schema.org/name`). Guards the `void:entities` sum on property
 *   partitions.
 *
 * With no aliases configured the transform is a no-op.
 *
 * @see substituteNormalizationMarkers for the query-time normalization used
 *   where summing is not safe.
 */
export function mergeNamespaceVariants(
  namespaceAliases: readonly NamespaceAlias[],
): QuadTransform<ReaderContext> {
  if (namespaceAliases.length === 0) {
    return (quads) => quads;
  }
  return async function* (quads, { dataset }) {
    const datasetIri = dataset.iri.toString();
    const buffered: Quad[] = [];
    for await (const q of quads) {
      buffered.push(q);
    }
    yield* mergeBuffered(buffered, datasetIri, namespaceAliases);
  };
}

/** One node’s describing quads, indexed for component lookup. */
interface NodeIndex {
  /** For a partition node: the structural predicate linking its parent to it. */
  incomingLink?: { predicate: string; parent: string };
  values: Map<string, Term>;
}

/** A running sum of one numeric measure, keyed by (subject, predicate). */
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
  const structural: Quad[] = [];

  for (const original of buffered) {
    const subject = remapTerm(original.subject, remap);
    const object = canonicalizeObject(
      remapTerm(original.object, remap),
      original.predicate.value,
      namespaceAliases,
    );
    const rewritten = quad(subject, original.predicate, object, original.graph);

    if (NUMERIC_MEASURES.has(original.predicate.value)) {
      accumulateMeasure(measureSums, rewritten);
      continue;
    }

    const key = quadKey(rewritten);
    if (!emitted.has(key)) {
      emitted.add(key);
      structural.push(rewritten);
    }
  }

  yield* structural;
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
 * partition (no incoming structural link). Replicates the queries’ minting:
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
      return klass ? mint(datasetIri, 'class', [canon(klass)]) : undefined;
    }
    case VOID_PROPERTY_PARTITION: {
      const klass = classOf(link.parent);
      const property = node.values.get(VOID_PROPERTY)?.value;
      return klass && property
        ? mint(datasetIri, 'class-property', [canon(klass), canon(property)])
        : undefined;
    }
    case VOIDEXT_DATATYPE_PARTITION: {
      const [klass, property] = classProperty(link.parent, nodes);
      const datatype = node.values.get(VOIDEXT_DATATYPE)?.value;
      return klass && property && datatype
        ? mint(datasetIri, 'datatype', [
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
        ? mint(datasetIri, 'object-class', [
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
        ? mint(datasetIri, 'language', [
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

function mint(
  datasetIri: string,
  prefix: string,
  components: string[],
): string {
  const hash = createHash('md5').update(components.join('')).digest('hex');
  return `${datasetIri}/.well-known/void#${prefix}-${hash}`;
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
