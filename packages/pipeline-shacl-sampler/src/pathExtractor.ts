import { DataFactory, Store } from 'n3';
import type { NamedNode, Term } from '@rdfjs/types';
import { rdfDereferencer } from 'rdf-dereference';
import { rdf, sh } from '@tpluscode/rdf-ns-builders';

const { namedNode } = DataFactory;

/**
 * A SHACL `sh:targetClass` shape distilled into the path chains the sampler
 * needs to walk to feed the validator a closed sample subgraph.
 */
export interface TargetShape {
  /** The class targeted by `sh:targetClass`. */
  targetClass: NamedNode;
  /**
   * Property-path chains rooted at a sampled instance of {@link targetClass}.
   *
   * Each chain is the sequence of `sh:path` IRIs leading from the sampled
   * subject to a node whose direct triples are needed for validation —
   * because the SHACL declares a nested-shape constraint on that path
   * (`sh:node`, `sh:class`, `sh:qualifiedValueShape`, or `sh:or` branches
   * that reference those). Chains continue recursively into every shape
   * thus referenced and stop on a cycle (a shape revisited on the current
   * stack) or on a leaf property shape whose constraints reference no
   * further shape.
   *
   * Each chain is *additive*: shorter prefixes are also present in the
   * list when they themselves terminate at a nested-shape property.
   */
  pathChains: NamedNode[][];
}

/**
 * Load a SHACL shapes file and extract its `sh:targetClass` shapes into
 * {@link TargetShape}s.
 *
 * Multiple NodeShapes can target the same class — they are merged into a
 * single entry. Only plain-IRI `sh:path` values are supported; sequence,
 * alternative and inverse paths throw.
 *
 * @param shapesFile URL or local path to the SHACL shapes file. Any format
 *   supported by `rdf-dereference` (Turtle, JSON-LD, N-Triples, …).
 */
export async function extractTargetShapes(
  shapesFile: string,
): Promise<TargetShape[]> {
  const store = await loadShapes(shapesFile);

  const classToShapes = new Map<string, Term[]>();
  for (const quad of store.getQuads(null, sh.targetClass, null, null)) {
    if (quad.object.termType !== 'NamedNode') continue;
    const key = quad.object.value;
    const list = classToShapes.get(key) ?? [];
    list.push(quad.subject);
    classToShapes.set(key, list);
  }

  const result: TargetShape[] = [];
  for (const [classIri, shapeIris] of classToShapes) {
    const pathChains: NamedNode[][] = [];
    const seen = new Set<string>();
    for (const shapeIri of shapeIris) {
      for (const chain of expandShape(
        store,
        shapeIri,
        new Set(),
        classToShapes,
      )) {
        const key = chainKey(chain);
        if (!seen.has(key)) {
          seen.add(key);
          pathChains.push(chain);
        }
      }
    }
    result.push({ targetClass: namedNode(classIri), pathChains });
  }

  return result;
}

/**
 * Walk one shape's property graph, producing every path chain that ends at a
 * nested-shape property. Cycle-detected via the {@link stack} of shape keys
 * the current recursion has entered but not yet left.
 */
function expandShape(
  store: Store,
  shape: Term,
  stack: Set<string>,
  classToShapes: ReadonlyMap<string, Term[]>,
): NamedNode[][] {
  const key = termKey(shape);
  if (stack.has(key)) return [];
  stack.add(key);

  const chains: NamedNode[][] = [];
  const seen = new Set<string>();
  for (const propQuad of store.getQuads(shape, sh.property, null, null)) {
    const propShape = propQuad.object;
    const analysis = valueShapeAnalysis(store, propShape, classToShapes);
    if (!analysis.emit) continue;
    const path = readPath(store, propShape);

    addUnique(chains, seen, [path]);
    for (const nestedRef of analysis.refs) {
      for (const subChain of expandShape(
        store,
        nestedRef,
        stack,
        classToShapes,
      )) {
        addUnique(chains, seen, [path, ...subChain]);
      }
    }
  }

  stack.delete(key);
  return chains;
}

interface ValueShapeAnalysis {
  /**
   * True if any value-shape constraint is present (`sh:node`, `sh:class`,
   * `sh:qualifiedValueShape`, or `sh:or` containing those) — independent of
   * whether each referenced class actually has a target shape in the SHACL.
   * Drives whether the sampler emits a chain ending at this property so the
   * validator can see the value node’s type triples.
   */
  emit: boolean;
  /**
   * Shapes the recursion should descend into for deeper chains: resolved
   * targets of `sh:class`, direct shape references from `sh:node` /
   * `sh:qualifiedValueShape`, and the same harvested from `sh:or` branches.
   */
  refs: Term[];
}

function valueShapeAnalysis(
  store: Store,
  constraintShape: Term,
  classToShapes: ReadonlyMap<string, Term[]>,
): ValueShapeAnalysis {
  const refs: Term[] = [];
  let emit = false;
  for (const q of store.getQuads(constraintShape, sh.node, null, null)) {
    emit = true;
    refs.push(q.object);
  }
  for (const q of store.getQuads(
    constraintShape,
    sh.qualifiedValueShape,
    null,
    null,
  )) {
    emit = true;
    refs.push(q.object);
  }
  for (const q of store.getQuads(constraintShape, sh.class, null, null)) {
    emit = true;
    if (q.object.termType !== 'NamedNode') continue;
    for (const target of classToShapes.get(q.object.value) ?? []) {
      refs.push(target);
    }
  }
  for (const q of store.getQuads(constraintShape, sh.or, null, null)) {
    for (const branch of orListBranches(store, q.object)) {
      const sub = valueShapeAnalysis(store, branch, classToShapes);
      if (sub.emit) emit = true;
      refs.push(...sub.refs);
    }
  }
  return { emit, refs };
}

function orListBranches(store: Store, listHead: Term): Term[] {
  const branches: Term[] = [];
  let current: Term = listHead;
  while (
    !(current.termType === 'NamedNode' && current.value === rdf.nil.value)
  ) {
    if (current.termType !== 'NamedNode' && current.termType !== 'BlankNode') {
      break;
    }
    const firsts = store.getQuads(current, rdf.first, null, null);
    if (firsts.length === 0) break;
    branches.push(firsts[0].object);
    const rests = store.getQuads(current, rdf.rest, null, null);
    if (rests.length === 0) break;
    current = rests[0].object;
  }
  return branches;
}

async function loadShapes(shapesFile: string): Promise<Store> {
  const { data } = await rdfDereferencer.dereference(shapesFile, {
    localFiles: true,
  });
  const store = new Store();
  await new Promise<void>((resolve, reject) =>
    store
      .import(data)
      .on('end', () => resolve())
      .on('error', reject),
  );
  return store;
}

function readPath(store: Store, propShape: Term): NamedNode {
  const pathQuads = store.getQuads(propShape, sh.path, null, null);
  if (pathQuads.length !== 1) {
    throw new Error(
      `Property shape ${termLabel(propShape)} must have exactly one sh:path; found ${pathQuads.length}`,
    );
  }
  const pathTerm = pathQuads[0].object;
  if (pathTerm.termType !== 'NamedNode') {
    throw new Error(
      `Unsupported sh:path form on property shape ${termLabel(propShape)}: ` +
        `only plain IRI paths are supported (sequence, alternative and inverse paths are not).`,
    );
  }
  return pathTerm;
}

function addUnique(
  chains: NamedNode[][],
  seen: Set<string>,
  chain: NamedNode[],
): void {
  const key = chainKey(chain);
  if (seen.has(key)) return;
  seen.add(key);
  chains.push(chain);
}

function chainKey(chain: NamedNode[]): string {
  return chain.map((n) => n.value).join('/');
}

function termKey(term: Term): string {
  return `${term.termType}:${term.value}`;
}

function termLabel(term: Term): string {
  return term.termType === 'BlankNode' ? `_:${term.value}` : `<${term.value}>`;
}
