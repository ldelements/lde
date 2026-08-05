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
 */
export function withDefaultGraph(
  query: QueryConstruct | QuerySelect,
  graphIri: string,
): void {
  query.datasets = F.datasetClauses(
    [{ clauseType: 'default', value: F.termNamed(F.gen(), graphIri) }],
    F.gen(),
  );
}
