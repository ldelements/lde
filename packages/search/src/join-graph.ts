import {
  labelSourceNameOf,
  referenceFields,
  type ReferenceField,
  type RootType,
  type SearchSchema,
  type SearchType,
} from './schema.js';

/**
 * The deepest `on` path a query may state: `dataset → publisher → country` is
 * three hops. Fixed rather than configurable, and enforced in the query IR
 * ({@link validateQuery}) rather than in an adapter, so a later REST surface
 * inherits the same ceiling. Typesense imposes no limit of its own, and the
 * GraphQL max-depth guard counts selection sets rather than input nesting, so
 * without this a `where` could nest a join arbitrarily deep and each hop is an
 * extra collection scan.
 */
export const MAX_JOIN_DEPTH = 3;

/**
 * The declared join edges of a {@link SearchSchema}: which Root Types are
 * reachable from which through {@link ReferenceField.joinable} references, and
 * which of them must be rebuilt together.
 *
 * Two members, because a consumer needs exactly two answers. A **query**
 * compiler asks *what does this path of field names reach* ({@link
 * JoinGraph.resolve}); a **writer** asks *which collections come into existence
 * together* ({@link JoinGraph.components}). Everything else – deriving the
 * edges from `joinable` + `labelSource`, the one-edge-per-target rule, cycle
 * rejection, the depth cap, and the asymmetry between undirected membership and
 * directed creation order – is hidden here, so no consumer restates it.
 *
 * `resolve` returns a {@link RootType}, never a collection name: how a type is
 * named in an engine is engine- and deployment-specific and stays in the
 * adapter.
 */
export interface JoinGraph {
  /**
   * The **join components**: groups of Root Types that reference one another,
   * directly or transitively, and therefore share a rebuild
   * ([ADR 19](../../docs/decisions/0019-filter-across-collections-through-declared-joins.md)).
   * Every Root Type appears in exactly one; a type with no joinable edge is a
   * singleton and keeps per-collection isolation exactly as before.
   *
   * Membership is the **undirected** connected component – a referrer and its
   * referent must rebuild together whichever way the edge points – while the
   * order **within** a component is the **directed** topological sort,
   * referenced first. That asymmetry is load-bearing: an engine cannot create a
   * collection whose reference names a collection that does not exist yet, so
   * the referent’s collection must be opened first.
   */
  readonly components: readonly (readonly RootType[])[];
  /**
   * The Root Type a path of joinable field names reaches from `from`, or
   * `undefined` when the path does not resolve – an unknown field name, a
   * reference that is not `joinable`, or a path deeper than
   * {@link MAX_JOIN_DEPTH}. An empty path resolves to `from` itself only when
   * `from` is a Root Type; a Reference Type has no collection to join to.
   */
  resolve(from: SearchType, path: readonly string[]): RootType | undefined;
}

/**
 * The join graph of a {@link SearchSchema}, built once per schema and cached:
 * {@link searchSchema} builds it eagerly, so a schema whose joins do not hold
 * up – two joinable fields at one target, a cycle – fails at startup rather
 * than on the first query or the first rebuild.
 *
 * Calling it again for the same schema returns the same graph.
 */
export function joinGraph(schema: SearchSchema): JoinGraph {
  const cached = graphsBySchema.get(schema);
  if (cached !== undefined) {
    return cached;
  }
  const built = buildJoinGraph(schema);
  graphsBySchema.set(schema, built);
  return built;
}

/** One graph per schema, held beside it rather than on it, so a
 *  {@link SearchSchema} stays a plain branded `Map`. */
const graphsBySchema = new WeakMap<SearchSchema, JoinGraph>();

/** One declared join edge: the field it is declared on and the Root Type it
 *  points at. */
interface JoinEdge {
  readonly field: ReferenceField;
  readonly target: RootType;
}

/** Every Root Type’s outgoing edges, keyed by class IRI then by field name. */
type EdgeIndex = ReadonlyMap<string, ReadonlyMap<string, JoinEdge>>;

/** The edges leaving one Root Type, keyed by field name. Total by
 *  construction: the index is built with an entry for EVERY Root Type, an empty
 *  map where a type declares none, so no caller needs a fallback it can never
 *  take. */
function edgesOf(
  edges: EdgeIndex,
  searchType: RootType,
): ReadonlyMap<string, JoinEdge> {
  return edges.get(searchType.class) as ReadonlyMap<string, JoinEdge>;
}

/** The edges leaving one Root Type, in declaration order. */
function edgesFrom(edges: EdgeIndex, searchType: RootType): Iterable<JoinEdge> {
  return edgesOf(edges, searchType).values();
}

/**
 * Derive, validate and index the edges. Throws – rather than reporting issues –
 * because it is called from {@link searchSchema}, whose contract is that an
 * invalid declaration fails at startup.
 */
function buildJoinGraph(schema: SearchSchema): JoinGraph {
  const rootTypes = [...schema.values()];
  const byName = new Map(rootTypes.map((type) => [type.name, type]));
  const edges = new Map<string, ReadonlyMap<string, JoinEdge>>();
  for (const searchType of rootTypes) {
    edges.set(searchType.class, declaredEdges(searchType, byName));
  }
  assertAcyclic(rootTypes, edges);
  return {
    components: componentsOf(rootTypes, edges),
    resolve(from: SearchType, path: readonly string[]) {
      if (path.length > MAX_JOIN_DEPTH) {
        return undefined;
      }
      // A Reference Type is never indexed, so it has no collection to join
      // from; only a member of this schema’s class map can start a path.
      const start =
        from.class === undefined ? undefined : schema.get(from.class);
      if (start === undefined || start !== from) {
        return undefined;
      }
      let current: RootType = start;
      for (const name of path) {
        const edge: JoinEdge | undefined = edgesOf(edges, current).get(name);
        if (edge === undefined) {
          return undefined;
        }
        current = edge.target;
      }
      return current;
    },
  };
}

/**
 * The joinable edges one Root Type declares, keyed by field name.
 *
 * Enforces the **one edge per (type, target)** rule here rather than in a
 * consumer: a Typesense join addresses the referent by *collection*, not by
 * field, so a second reference to the same collection is accepted, indexed and
 * then unreachable – the engine resolves every join through the first field
 * that matched and silently ignores the rest
 * ({@link https://github.com/typesense/typesense/issues/3021}). `publisher` and
 * `creator` both resolving to `Organization` is the ordinary case, so it must
 * be a declaration error naming both fields rather than a surprise at query
 * time.
 */
function declaredEdges(
  searchType: RootType,
  byName: ReadonlyMap<string, RootType>,
): ReadonlyMap<string, JoinEdge> {
  const edges = new Map<string, JoinEdge>();
  const claimedBy = new Map<string, string>();
  for (const field of referenceFields(searchType)) {
    if (field.joinable !== true) {
      continue;
    }
    // Both lookups always hit: `validateSearchType` rejects `joinable` on a
    // reference that names no type to resolve against, and such a type is
    // always an indexed Root Type – it must declare a `searchable` label
    // field, which a Reference Type cannot carry (a nested field is `output`
    // only). So a joinable edge always has a collection at the far end without
    // a rule of its own.
    const target = byName.get(labelSourceNameOf(field) as string) as RootType;
    const claimed = claimedBy.get(target.name);
    if (claimed !== undefined) {
      throw new Error(
        `Search type “${searchType.name}” declares two joinable references to “${target.name}” (“${claimed}” and “${field.name}”); an engine addresses a join by collection, not by field, so only one reference per target can be joinable. Drop “joinable” from one of them – it keeps its labels, facets and id filtering.`,
      );
    }
    claimedBy.set(target.name, field.name);
    edges.set(field.name, { field, target });
  }
  return edges;
}

/**
 * Reject a cycle in the **directed** join graph. A cycle would make the
 * topological creation order below undefinable – there is no collection to
 * create first – and, with the component as the unit of rebuild, no order in
 * which a component’s collections could come into existence at all.
 */
function assertAcyclic(
  rootTypes: readonly RootType[],
  edges: ReadonlyMap<string, ReadonlyMap<string, JoinEdge>>,
): void {
  const done = new Set<string>();
  const visit = (searchType: RootType, onPath: readonly RootType[]): void => {
    if (onPath.some((ancestor) => ancestor.class === searchType.class)) {
      const cycle = [...onPath, searchType]
        .map((type) => `“${type.name}”`)
        .join(' → ');
      throw new Error(
        `Join cycle ${cycle}; the joinable references between search types must be acyclic, so a component’s collections have an order to be created in.`,
      );
    }
    if (done.has(searchType.class)) {
      return;
    }
    const extended = [...onPath, searchType];
    for (const edge of edgesFrom(edges, searchType)) {
      visit(edge.target, extended);
    }
    done.add(searchType.class);
  };
  for (const searchType of rootTypes) {
    visit(searchType, []);
  }
}

/**
 * Partition the Root Types into join components, each topologically ordered.
 *
 * Membership is the undirected connected component (union-find over the
 * edges); the order within one is a depth-first topological sort over the
 * directed edges, so a type is emitted only after everything it references.
 * Components come out in declaration order of their first member, so a schema’s
 * rebuild order is stable across runs.
 */
function componentsOf(
  rootTypes: readonly RootType[],
  edges: ReadonlyMap<string, ReadonlyMap<string, JoinEdge>>,
): readonly (readonly RootType[])[] {
  const parent = new Map(rootTypes.map((type) => [type.class, type.class]));
  const find = (iri: string): string => {
    let root = iri;
    while (parent.get(root) !== root) {
      root = parent.get(root) as string;
    }
    return root;
  };
  for (const searchType of rootTypes) {
    for (const edge of edgesFrom(edges, searchType)) {
      parent.set(find(searchType.class), find(edge.target.class));
    }
  }
  const members = new Map<string, RootType[]>();
  for (const searchType of rootTypes) {
    const root = find(searchType.class);
    members.set(root, [...(members.get(root) ?? []), searchType]);
  }
  return [...members.values()].map((component) =>
    topologicallyOrdered(component, edges),
  );
}

/** One component’s members, everything a type references before the type
 *  itself. Terminates because {@link assertAcyclic} ran first. */
function topologicallyOrdered(
  component: readonly RootType[],
  edges: ReadonlyMap<string, ReadonlyMap<string, JoinEdge>>,
): readonly RootType[] {
  const ordered: RootType[] = [];
  const emitted = new Set<string>();
  const visit = (searchType: RootType): void => {
    if (emitted.has(searchType.class)) {
      return;
    }
    emitted.add(searchType.class);
    for (const edge of edgesFrom(edges, searchType)) {
      visit(edge.target);
    }
    ordered.push(searchType);
  };
  for (const searchType of component) {
    visit(searchType);
  }
  return ordered;
}
