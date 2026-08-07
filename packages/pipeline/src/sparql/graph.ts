import { assertSafeIri } from '@lde/dataset';
import {
  AstFactory,
  type QueryConstruct,
  type QuerySelect,
} from '@traqula/rules-sparql-1-1';

const F = new AstFactory();

/**
 * Set the default graph (FROM clause) on a parsed CONSTRUCT or SELECT query.
 *
 * Mutates the query in place, replacing any existing FROM clause.
 *
 * Both query forms scope the same way, and a stage reading a
 * {@link Distribution} with a `namedGraph` must scope **both**: were only the
 * reader to honour it, an item selector would pick its roots from the whole
 * endpoint and the reader would then find nothing for most of them.
 *
 * The graph IRI is {@link assertSafeIri}-checked before it becomes an `<…>`
 * reference: a `namedGraph` is a plain string, typically carried in from
 * third-party registry data, and one containing an angle bracket or whitespace
 * would break out of the IRI reference and rewrite the query around it.
 */
export function withDefaultGraph(
  query: QueryConstruct | QuerySelect,
  graphIri: string,
): void {
  assertSafeIri(graphIri);
  query.datasets = F.datasetClauses(
    [{ clauseType: 'default', value: F.termNamed(F.gen(), graphIri) }],
    F.gen(),
  );
}
