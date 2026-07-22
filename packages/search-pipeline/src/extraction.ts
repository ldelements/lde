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
  irAlias,
  isInlineReference,
  referenceTypeNamed,
} from '@lde/search/adapter';
import type { SearchSchema, SearchType } from '@lde/search';

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
  const built = buildFor(searchType, subject, schema, { next: 0 });
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
 * paths). Recurses into an inline reference’s type off a fresh referent
 * variable, so the nested template keeps the `subject → referent → value` link
 * in one CONSTRUCT. The recursion terminates because `searchSchema` rejects
 * inline reference cycles.
 */
function buildFor(
  searchType: SearchType,
  subject: TermVariable,
  schema: SearchSchema,
  counter: VariableCounter,
): Built {
  const template: TripleNesting[] = [];
  const branches: PatternGroup[] = [];
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
      const nested = buildFor(referenceType, referent, schema, counter);
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
      branches.push(
        factory.patternGroup(
          [
            factory.patternBgp(
              [factory.triple(subject, sourcePath, value)],
              factory.gen(),
            ),
          ],
          factory.gen(),
        ),
      );
    }
  }
  return { template, branches };
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
