import {
  AstFactory,
  type Pattern,
  type PatternBgp,
  type PatternGroup,
  type QueryConstruct,
  type QuerySelect,
  type TermVariable,
  type TripleNesting,
} from '@traqula/rules-sparql-1-1';
import { Parser } from '@traqula/parser-sparql-1-1';
import { Generator } from '@traqula/generator-sparql-1-1';
import {
  fieldNamed,
  irAlias,
  isInlineReference,
  labelSourceNameOf,
  localLookupTypeOf,
  referenceTypeNamed,
  rootTypeNamed,
} from '@lde/search/adapter';
import type {
  ReferenceField,
  RootType,
  SearchField,
  SearchSchema,
  SearchType,
} from '@lde/search';

const factory = new AstFactory();
const parser = new Parser();
const generator = new Generator();

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
 *   one BGP cross-multiplies the multi-valued ones (~4× inflation).
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
 *   needs nothing: a key field is a declared field, so its own branch and
 *   template triple are already there.
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
  const built = buildFor(searchType, subject, schema, { next: 0 }, new Set());
  if (built.branches.length === 0) {
    throw new Error(
      `Cannot generate an extraction CONSTRUCT for “${searchType.name}”: it declares no path-bearing field, so there is nothing to extract.`,
    );
  }
  const where = factory.patternGroup(
    [factory.patternUnion(built.branches, factory.gen())],
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
      const patterns: Pattern[] = [
        factory.patternBgp(
          [factory.triple(subject, sourcePath, referent)],
          factory.gen(),
        ),
      ];
      // A single-branch union serialises to just its group, so only add the
      // nested union when the reference type has fields of its own.
      if (nested.branches.length > 0) {
        patterns.push(factory.patternUnion(nested.branches, factory.gen()));
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
      const local = localTargetOf(field, schema, onPath);
      if (local === undefined) {
        // Only where no local expansion follows: a `local` lookup reads the
        // target’s every path-bearing field, and a keyed target’s key field is
        // one of them, so emitting the hop as well would state it twice.
        const keyed = keyedTargetOf(field, schema);
        if (keyed !== undefined) {
          const built = buildKeyHop(
            keyed.target,
            keyed.keyField,
            value,
            counter,
          );
          template.push(built.triple);
          patterns.push(built.pattern);
        }
      } else {
        const nested = buildFor(local, value, schema, counter, onPath);
        template.push(...nested.template);
        // `OPTIONAL`, unlike an inline reference’s conjoined nesting: this
        // referent is stored by id whether or not the referring document says
        // anything about it, and conjoining would drop both together.
        if (nested.branches.length > 0) {
          patterns.push(
            factory.patternOptional(
              [factory.patternUnion(nested.branches, factory.gen())],
              factory.gen(),
            ),
          );
        }
      }
      branches.push(factory.patternGroup(patterns, factory.gen()));
    }
  }
  return { template, branches };
}

/**
 * The Root Type a {@link ReferenceStrategy.local} lookup expands into here, or
 * `undefined` where the field declares none – or where that type is already on
 * this path, which is where the recursion stops.
 */
function localTargetOf(
  field: SearchField,
  schema: SearchSchema,
  visiting: ReadonlySet<string>,
): RootType | undefined {
  const local = localLookupTypeOf(field, schema);
  return local === undefined || visiting.has(local.name) ? undefined : local;
}

/**
 * The keyed Root Type a reference points at, with the field its key is read
 * from: a `lookup`’s `target` or an `idOnly`’s `labelSource`
 * ({@link labelSourceNameOf}) that declares a {@link RootType.key}, or
 * `undefined` for every other field. Naming the target is exactly the boundary
 * the projection re-keys along, so the extraction reads the same declarations
 * rather than a rule of its own: a reference that names no target keeps the
 * node IRI, and needs no hop.
 */
function keyedTargetOf(
  field: SearchField,
  schema: SearchSchema,
): { readonly target: RootType; readonly keyField: KeyedField } | undefined {
  if (field.kind !== 'reference') {
    return undefined;
  }
  const targetName = labelSourceNameOf(field as ReferenceField);
  const target =
    targetName === undefined ? undefined : rootTypeNamed(schema, targetName);
  if (target?.key === undefined) {
    return undefined;
  }
  // `searchSchema` guarantees a declared, path-bearing key field, so the target
  // – which came out of the schema – always has one.
  const keyField = fieldNamed(target, target.key.field) as KeyedField;
  return { target, keyField };
}

/** A key field as the schema guarantees it: path-bearing. */
type KeyedField = SearchField & { readonly path: string };

/**
 * The one-field hop that reads a referent’s key: a template triple emitting the
 * key field under the **target’s** IR Alias, and an `OPTIONAL` branch binding
 * it. The referent recursion an inline reference already performs, for a single
 * field and wrapped in `OPTIONAL` rather than conjoined – so a referent with no
 * key candidate keeps its row and still stores its own IRI, instead of the
 * whole reference dropping out of the CONSTRUCT.
 *
 * It sits inside its own UNION branch (the one the reference contributes), so it
 * multiplies against nothing.
 */
function buildKeyHop(
  target: RootType,
  keyField: KeyedField,
  referent: TermVariable,
  counter: VariableCounter,
): { readonly triple: TripleNesting; readonly pattern: Pattern } {
  const key = factory.termVariable(`k${counter.next++}`, factory.gen());
  return {
    triple: factory.triple(
      referent,
      factory.termNamed(factory.gen(), irAlias(target, keyField)),
      key,
    ),
    pattern: factory.patternOptional(
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
