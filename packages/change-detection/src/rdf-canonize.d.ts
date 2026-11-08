declare module 'rdf-canonize' {
  /** A term in rdf-canonize’s JSON dataset shape: blank node values carry `_:`. */
  interface Term {
    termType: string;
    value: string;
    datatype?: { termType: string; value: string };
    language?: string;
  }

  interface Quad {
    subject: Term;
    predicate: Term;
    object: Term;
    graph: Term;
  }

  /** Canonicalize a dataset and return it as canonical N-Quads. */
  export function canonize(
    input: Quad[],
    options: { algorithm: 'RDFC-1.0' },
  ): Promise<string>;
}
