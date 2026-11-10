import {
  AstFactory,
  type Pattern,
  type PatternBgp,
  type PatternGroup,
  type QueryConstruct,
  type QuerySelect,
  type TermIri,
  type TermVariable,
  type TripleNesting,
} from '@traqula/rules-sparql-1-1';
import { Parser } from '@traqula/parser-sparql-1-1';
import { Generator } from '@traqula/generator-sparql-1-1';
import {
  endpointFieldOf,
  fieldNamed,
  irAlias,
  isInlineReference,
  localLookupTargetsOf,
  referencedTargetsOf,
  referenceTypeNamed,
} from '@lde/search/adapter';
import type {
  RootType,
  SearchField,
  SearchSchema,
  SearchType,
} from '@lde/search';

const factory = new AstFactory();
const parser = new Parser();
const generator = new Generator();

const RDF_TYPE = 'http://www.w3.org/1999/02/22-rdf-syntax-ns#type';

/** Options for {@link extractionQuery}. */
export interface ExtractionOptions {
  /**
   * The variable the roots bind to. Left free in the generated query for the
   * pipeline’s VALUES injection (`injectValues`), so it must match the stage’s
   * `rootVariable` – the variable the item selector projects. Defaults to
   * `root`, matching `selectByClass`. Must not be `dataset` (the SPARQL reader
   * substitutes `?dataset` with the dataset IRI).
   * @default 'root'
   */
  readonly subjectVariable?: string;
}

/**
 * Generate a type’s **Extraction** CONSTRUCT from its {@link SearchType}
 * declaration: the query whose output the projection frames and reads. Pure –
 * `SearchType → QueryConstruct` – with no engine or deployment knowledge.
 *
 * - **template**: one `?root <`{@link irAlias IR Alias}`> ?value` triple per
 *   path-bearing field – IRIs only, a single subject. A property path cannot be
 *   a CONSTRUCT verb, so the flattened value must be minted onto its subject
 *   under the field’s alias; the projection reads it back under the same alias.
 * - **WHERE**: one UNION branch per field (`?root <path> ?value`), the field’s
 *   `path` embedded as a literal SPARQL property path (sequence / alternative /
 *   inverse). UNION per branch, never a conjunction – conjoining every path in
 *   one BGP cross-multiplies the multi-valued ones (~4× inflation). Fields
 *   whose path is a single predicate share one branch instead, reading them
 *   through a `VALUES` table ({@link mergePlainReads}).
 * - **roots**: the subject variable is left free, to be bound by the pipeline’s
 *   `injectValues` (`VALUES ?root { … }`). Root *selection* is a separate,
 *   deployment concern (`selectByClass` / the stage’s `itemSelector`); this
 *   generator emits IR Aliases, the selector queries the source class.
 * - **inline references** ({@link isInlineReference}): one CONSTRUCT with a
 *   nested template (`{ ?root <…/ref> ?r . ?r <…/field> ?v }`), recursing into
 *   the reference type to the schema’s declared depth. The referent-binding hop
 *   uses the source `path`; the emitted triples use the minted aliases.
 * - **`local` lookups** ({@link ReferenceStrategy.local}): a reference that also
 *   stores what this document states about its referent gets its branch
 *   extended with the **target Root Type’s own** fields, read off the referent
 *   and emitted under that type’s aliases – the same recursion an inline
 *   reference makes, through a Root Type rather than a Reference Type, and the
 *   same reach {@link inlineFramingDepth} already frames for. `OPTIONAL`, so a
 *   referent the document states nothing about keeps its row and still stores
 *   its id. It subsumes the key hop below, the key field being one of the
 *   target’s own.
 * - **references into a keyed type**: a reference naming a target that declares
 *   a `key` gets its branch extended with an `OPTIONAL` hop reading the
 *   referent’s key field, emitted under the **target’s** alias for it – so the
 *   projection can store the referent’s document key rather than its node IRI.
 *   `OPTIONAL`, so a referent with no key candidate keeps its row. The root side
 *   needs nothing: a key field is a declared field, so its own read and
 *   template triple are already there.
 * - **references naming several targets**: the referent may be of any of them,
 *   so its branch also reads the referent’s `rdf:type` (`OPTIONAL`, emitted
 *   as is – framing carries it as `@type`), which is what the projection
 *   matches against each target’s `class` to tell which one it is. Every
 *   target then contributes its own expansion or key hop, so whichever the
 *   referent turns out to be, its declaration is in the frame.
 *
 * Wire the result into a `SparqlConstructReader` (see `searchStages`), which
 * runs it per batch with the roots injected as VALUES.
 */
export function extractionQuery(
  searchType: SearchType,
  schema: SearchSchema,
  options: ExtractionOptions = {},
): QueryConstruct {
  const subjectVariable = options.subjectVariable ?? 'root';
  const subject = factory.termVariable(subjectVariable, factory.gen());
  const counter = { next: 0 };
  const built = buildFor(searchType, subject, schema, counter, new Set());
  if (built.branches.length === 0) {
    throw new Error(
      `Cannot generate an extraction CONSTRUCT for “${searchType.name}”: it declares no path-bearing field, so there is nothing to extract.`,
    );
  }
  const where = factory.patternGroup(
    [
      factory.patternUnion(
        mergePlainReads(built.branches, built.template, counter),
        factory.gen(),
      ),
    ],
    factory.gen(),
  );
  return factory.queryConstruct(
    factory.gen(),
    [],
    factory.patternBgp(built.template, factory.gen()),
    where,
    {},
    factory.datasetClauses([], factory.gen()),
  );
}

/** {@link extractionQuery}, serialised to a SPARQL string a reader can run. */
export function extractionQueryString(
  searchType: SearchType,
  schema: SearchSchema,
  options?: ExtractionOptions,
): string {
  return generator.generate(extractionQuery(searchType, schema, options));
}

/** A per-query counter minting distinct value/referent variable names. */
interface VariableCounter {
  next: number;
}

/** The template triples and WHERE branches a type contributes off `subject`. */
interface Built {
  readonly template: TripleNesting[];
  readonly branches: PatternGroup[];
}

/**
 * Walk a type’s path-bearing fields off a subject variable, collecting the
 * template triples (minted aliases) and one WHERE branch per field (source
 * paths). Recurses off a fresh referent variable for the two references that
 * store a referent’s fields rather than only its id – an inline reference,
 * through its Reference Type, and a {@link ReferenceStrategy.local} lookup,
 * through its target Root Type – so the nested template keeps the
 * `subject → referent → value` link in one CONSTRUCT.
 *
 * `visiting` is what terminates the second one. `searchSchema` rejects inline
 * reference cycles, but nothing forbids two Root Types whose `local` lookups
 * point at each other, so a type already on this path contributes no further
 * hop – the same cut {@link inlineFramingDepth} makes, so the depth framed and
 * the depth extracted stay the same number.
 */
function buildFor(
  searchType: SearchType,
  subject: TermVariable,
  schema: SearchSchema,
  counter: VariableCounter,
  visiting: ReadonlySet<string>,
): Built {
  const template: TripleNesting[] = [];
  const branches: PatternGroup[] = [];
  const onPath = new Set(visiting).add(searchType.name);
  for (const field of searchType.fields) {
    if (field.path === undefined) {
      continue;
    }
    const alias = factory.termNamed(factory.gen(), irAlias(searchType, field));
    const sourcePath = liftPath(field.path);
    if (isInlineReference(field)) {
      const referenceType = referenceTypeNamed(schema, field.ref.typeName);
      if (referenceType === undefined) {
        continue;
      }
      const referent = factory.termVariable(
        `r${counter.next++}`,
        factory.gen(),
      );
      template.push(factory.triple(subject, alias, referent));
      const nested = buildFor(referenceType, referent, schema, counter, onPath);
      template.push(...nested.template);
      const nestedBranches = [...nested.branches];
      // A graph that may leave the edge out: the node the work points at may be
      // the endpoint itself, so its type – which tells the two apart – and the
      // endpoint’s own selection are read right here, beside the edge’s fields.
      const endpointField = endpointFieldOf(referenceType, field.ref.identity);
      if (endpointField !== undefined) {
        // An empty branch: an endpoint the graph says nothing else about keeps
        // its row, and so its id, as it would inside an edge – a literal too.
        nestedBranches.push(factory.patternGroup([], factory.gen()));
        const typeHop = buildTypeHop(referent, counter);
        template.push(typeHop.triple);
        nestedBranches.push(typeHop.pattern);
        const hops = buildReferentHops(
          endpointField,
          referent,
          schema,
          counter,
          onPath,
        );
        template.push(...hops.template);
        nestedBranches.push(...hops.expansions);
      } else if (referenceType.literalField !== undefined) {
        // A literal stated in place of the node has no values of its own to
        // read, so it keeps its row through an empty branch. Not narrowed to
        // literals: a branch is evaluated on its own, so a `FILTER(isLiteral)`
        // in it sees the referent unbound and drops every row. A node that
        // keeps its row this way, reading nothing, projects to nothing.
        nestedBranches.push(factory.patternGroup([], factory.gen()));
      }
      const patterns: Pattern[] = [
        factory.patternBgp(
          [factory.triple(subject, sourcePath, referent)],
          factory.gen(),
        ),
      ];
      // A single-branch union serialises to just its group, so only add the
      // nested union when the reference type has fields of its own.
      if (nestedBranches.length > 0) {
        patterns.push(
          factory.patternUnion(
            mergePlainReads(nestedBranches, template, counter),
            factory.gen(),
          ),
        );
      }
      branches.push(factory.patternGroup(patterns, factory.gen()));
    } else {
      const value = factory.termVariable(`v${counter.next++}`, factory.gen());
      template.push(factory.triple(subject, alias, value));
      const patterns: Pattern[] = [
        factory.patternBgp(
          [factory.triple(subject, sourcePath, value)],
          factory.gen(),
        ),
      ];
      // The type tells several targets apart; one target needs none.
      const expansions: PatternGroup[] = [];
      if (referencedTargetsOf(field, schema).length > 1) {
        const typeHop = buildTypeHop(value, counter);
        template.push(typeHop.triple);
        expansions.push(typeHop.pattern);
      }
      const hops = buildReferentHops(field, value, schema, counter, onPath);
      template.push(...hops.template);
      expansions.push(...hops.expansions);
      // `OPTIONAL`, unlike an inline reference’s conjoined nesting: this
      // referent is stored by id whether or not the referring document says
      // anything about it, and conjoining would drop both together. Several
      // targets’ expansions share the one UNION: a referent is of one kind,
      // and the branches of the others simply bind nothing for it. A
      // single-branch union serialises to just its group.
      if (expansions.length > 0) {
        patterns.push(
          factory.patternOptional(
            [
              factory.patternUnion(
                mergePlainReads(expansions, template, counter),
                factory.gen(),
              ),
            ],
            factory.gen(),
          ),
        );
      }
      branches.push(factory.patternGroup(patterns, factory.gen()));
    }
  }
  return { template, branches };
}

/**
 * Fold a union’s **plain reads** – branches that are one `?s <iri> ?o` triple –
 * into one branch per subject: `?s ?p ?o`, joined with a `VALUES` table that
 * pairs each read’s predicate with the alias it is emitted under, and one
 * template triple `?s ?alias ?o` in place of theirs. The output is the same
 * triples: each table row still binds only its own values, so multi-valued
 * fields still add rather than multiply.
 *
 * It exists for QLever, which evaluates every branch of a union as an operation
 * of its own. Under the `OPTIONAL` of a reference’s reads, those branches ran
 * out of its default 4 GB memory budget on a batch of ten roots that used under
 * 200 MB (ad-freiburg/qlever#3898); one scan per subject instead of one per
 * field also reads a predicate that several targets share – `name`, `sameAs` –
 * once rather than once per target. Measured on LOL’s CreativeWork extraction,
 * median over 30 batches of ten on a running server: 320 ms at an 8 GB budget
 * before, 100 ms at the default 4 GB after, and both LDMax QLever endpoints,
 * which refused the old shape, answer in about 250 ms. A branch with a property
 * path or a hop of its own stays as it is, and so does a subject’s only plain
 * read.
 *
 * The triple comes before the `VALUES`, so `injectValues` still finds the root
 * bound by a leading triple pattern and puts its roots into this branch too.
 */
function mergePlainReads(
  branches: readonly PatternGroup[],
  template: TripleNesting[],
  counter: VariableCounter,
): PatternGroup[] {
  const readsBySubject = new Map<string, PlainRead[]>();
  for (const branch of branches) {
    const read = plainReadOf(branch, template);
    if (read !== undefined) {
      const reads = readsBySubject.get(read.subject.value) ?? [];
      reads.push(read);
      readsBySubject.set(read.subject.value, reads);
    }
  }
  // A merged branch takes the place of the first read it replaces; the others
  // are dropped.
  const replacements = new Map<PatternGroup, PatternGroup>();
  const dropped = new Set<PatternGroup>();
  for (const reads of readsBySubject.values()) {
    if (reads.length < 2) {
      continue;
    }
    const [first, ...others] = reads as [PlainRead, ...PlainRead[]];
    const { subject } = first;
    const predicate = factory.termVariable(`p${counter.next}`, factory.gen());
    const alias = factory.termVariable(`a${counter.next}`, factory.gen());
    const value = factory.termVariable(`o${counter.next++}`, factory.gen());
    // In the place of the first triple it replaces, so the template keeps the
    // order the fields are declared in.
    for (const read of others) {
      template.splice(template.indexOf(read.templateTriple), 1);
      dropped.add(read.branch);
    }
    template.splice(
      template.indexOf(first.templateTriple),
      1,
      factory.triple(subject, alias, value),
    );
    const branch = factory.patternGroup(
      [
        factory.patternBgp(
          [factory.triple(subject, predicate, value)],
          factory.gen(),
        ),
        factory.patternValues(
          [predicate, alias],
          reads.map((read) => ({
            [predicate.value]: read.predicate,
            [alias.value]: read.templateTriple.predicate,
          })),
          factory.gen(),
        ),
      ],
      factory.gen(),
    );
    replacements.set(first.branch, branch);
  }
  return branches
    .filter((branch) => !dropped.has(branch))
    .map((branch) => replacements.get(branch) ?? branch);
}

/** A branch that reads one plain predicate off a subject, with the template
 *  triple that emits what it binds under its alias. */
interface PlainRead {
  readonly branch: PatternGroup;
  readonly subject: TermVariable;
  readonly predicate: TermIri;
  readonly templateTriple: TripleNesting & { readonly predicate: TermIri };
}

/**
 * The plain read a branch is, if it is one: a single `?s <iri> ?o` triple, with
 * the template triple `?s <alias> ?o` that emits its value.
 */
function plainReadOf(
  branch: PatternGroup,
  template: readonly TripleNesting[],
): PlainRead | undefined {
  const [pattern, ...rest] = branch.patterns;
  if (
    pattern === undefined ||
    rest.length > 0 ||
    !factory.isPatternBgp(pattern) ||
    pattern.triples.length !== 1
  ) {
    return undefined;
  }
  const [triple] = pattern.triples;
  if (
    triple === undefined ||
    !factory.isTriple(triple) ||
    !factory.isTermVariable(triple.subject) ||
    !factory.isTermNamed(triple.predicate) ||
    !factory.isTermVariable(triple.object)
  ) {
    return undefined;
  }
  const { subject, predicate, object } = triple;
  // Every value this generator binds is emitted by exactly one template triple,
  // off the same subject and under a minted alias, so that triple is there. A
  // value read on from – a referent with fields – never gets here: its branch
  // holds the hops too.
  const templateTriple = template.find(
    (candidate) =>
      factory.isTermVariable(candidate.object) &&
      candidate.object.value === object.value,
  ) as TripleNesting & { readonly predicate: TermIri };
  return {
    branch,
    subject,
    predicate,
    templateTriple,
  };
}

/**
 * The hops a reference reads off its referent besides its type: each keyed
 * target’s key and each `local` target’s own fields. Each is its own branch,
 * so the caller binds them in ONE union where each binds only its own
 * variables, and a multi-valued key multiplies against nothing – also once
 * {@link mergePlainReads} has folded the plain ones into a `VALUES` table, whose
 * rows each bind one read too.
 */
function buildReferentHops(
  field: SearchField,
  referent: TermVariable,
  schema: SearchSchema,
  counter: VariableCounter,
  onPath: ReadonlySet<string>,
): { readonly template: TripleNesting[]; readonly expansions: PatternGroup[] } {
  const template: TripleNesting[] = [];
  const expansions: PatternGroup[] = [];
  const targets = referencedTargetsOf(field, schema);
  const local = localTargetsOf(field, schema, onPath);
  for (const target of targets) {
    if (!local.includes(target)) {
      // Only where no local expansion follows: a `local` lookup reads the
      // target’s every path-bearing field, and a keyed target’s key field
      // is one of them, so emitting the hop as well would state it twice.
      const keyed = keyedFieldOf(target);
      if (keyed !== undefined) {
        const built = buildKeyHop(target, keyed, referent, counter);
        template.push(built.triple);
        expansions.push(built.pattern);
      }
      continue;
    }
    const nested = buildFor(target, referent, schema, counter, onPath);
    template.push(...nested.template);
    expansions.push(...nested.branches);
  }
  return { template, expansions };
}

/**
 * The Root Types a {@link ReferenceStrategy.local} lookup expands into here:
 * none where the field declares none, and never one already on this path,
 * which is where the recursion stops.
 */
function localTargetsOf(
  field: SearchField,
  schema: SearchSchema,
  visiting: ReadonlySet<string>,
): readonly RootType[] {
  return localLookupTargetsOf(field, schema).filter(
    (target) => !visiting.has(target.name),
  );
}

/**
 * The field a Root Type’s key is read from, when it declares a
 * {@link RootType.key}. Naming the target is exactly the boundary the
 * projection re-keys along ({@link referencedTargetsOf}), so the extraction
 * reads the same declarations rather than a rule of its own: a reference that
 * names no target keeps the node IRI, and needs no hop.
 */
function keyedFieldOf(target: RootType): KeyedField | undefined {
  if (target.key === undefined) {
    return undefined;
  }
  // `searchSchema` guarantees a declared, path-bearing key field, so the target
  // – which came out of the schema – always has one.
  return fieldNamed(target, target.key.field) as KeyedField;
}

/**
 * The one-triple hop that reads a referent’s `rdf:type`, for a reference whose
 * referent may be of several kinds: emitted under `rdf:type` itself, which
 * framing turns into the node’s `@type`. The caller binds it inside the
 * reference’s `OPTIONAL` union, so an untyped referent keeps its row and falls
 * back to the first target declared.
 */
function buildTypeHop(
  referent: TermVariable,
  counter: VariableCounter,
): { readonly triple: TripleNesting; readonly pattern: PatternGroup } {
  const type = factory.termVariable(`t${counter.next++}`, factory.gen());
  const predicate = factory.termNamed(factory.gen(), RDF_TYPE);
  return {
    triple: factory.triple(referent, predicate, type),
    pattern: factory.patternGroup(
      [
        factory.patternBgp(
          [factory.triple(referent, predicate, type)],
          factory.gen(),
        ),
      ],
      factory.gen(),
    ),
  };
}

/** A key field as the schema guarantees it: path-bearing. */
type KeyedField = SearchField & { readonly path: string };

/**
 * The one-field hop that reads a referent’s key: a template triple emitting the
 * key field under the **target’s** IR Alias, and a branch binding it. The
 * referent recursion an inline reference already performs, for a single field –
 * bound by the caller inside the reference’s `OPTIONAL` union rather than
 * conjoined, so a referent with no key candidate keeps its row and still stores
 * its own IRI, instead of the whole reference dropping out of the CONSTRUCT.
 *
 * It is a branch of its own in that union, or a row of its merged plain reads,
 * so it multiplies against nothing.
 */
function buildKeyHop(
  target: RootType,
  keyField: KeyedField,
  referent: TermVariable,
  counter: VariableCounter,
): { readonly triple: TripleNesting; readonly pattern: PatternGroup } {
  const key = factory.termVariable(`k${counter.next++}`, factory.gen());
  return {
    triple: factory.triple(
      referent,
      factory.termNamed(factory.gen(), irAlias(target, keyField)),
      key,
    ),
    pattern: factory.patternGroup(
      [
        factory.patternBgp(
          [factory.triple(referent, liftPath(keyField.path), key)],
          factory.gen(),
        ),
      ],
      factory.gen(),
    ),
  };
}

/**
 * Lift a field’s `path` – written in the SPARQL reader adapter’s grammar (a
 * property path) – into a predicate AST node, by parsing it inside a throwaway
 * query and taking the verb. A single IRI yields a plain named node; a
 * sequence / alternative / inverse yields a path node. The WHERE consumes it;
 * the CONSTRUCT template never does (a path cannot be a template verb).
 */
function liftPath(path: string): TripleNesting['predicate'] {
  // Always a single-triple SELECT by construction, so the verb is at a fixed
  // spot; a malformed `path` makes the parser itself throw, which is the right
  // failure for invalid reader-adapter grammar.
  const ast = parser.parse(`SELECT * WHERE { ?s ${path} ?o }`) as QuerySelect;
  const bgp = ast.where.patterns[0] as PatternBgp;
  const triple = bgp.triples[0] as TripleNesting;
  return triple.predicate;
}
