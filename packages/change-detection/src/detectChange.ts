import type { DatasetCore, Quad, Term } from '@rdfjs/types';
import { createHash } from 'node:crypto';
import { canonize } from 'rdf-canonize';
import { contentHashPredicate, hashVersionPredicate } from './vocabulary.js';

/**
 * A document’s content hash and the caller’s conversion version it was taken
 * under, as {@link detectChange} returns it and the store keeps it.
 */
export interface ContentHash {
  /** The hash, prefixed with the hashing method, e.g. `rdfc10-sha256:…`. */
  readonly hash: string;
  /** The caller’s conversion version, compared for equality only. */
  readonly version: string;
}

/**
 * How a document compares to its stored hash.
 *
 * - `created`: no hash is stored.
 * - `changed`: the content differs under the same version.
 * - `reconverted`: the version or the hashing method differs, so the written
 *   content may differ although the source need not have.
 * - `unchanged`: content, version and hashing method all match; skip the write.
 */
export type ChangeStatus = 'created' | 'changed' | 'reconverted' | 'unchanged';

/**
 * Thrown by {@link detectChange} for a document that RDFC-1.0 cannot
 * canonicalize within its work limit, such as one with many indistinguishable
 * blank nodes. Such a document can be written, but not hashed.
 */
export class CanonicalizationLimitError extends Error {
  constructor(options?: ErrorOptions) {
    super('The document is too costly to canonicalize', options);
    this.name = 'CanonicalizationLimitError';
  }
}

/**
 * Compare a document to its stored hash.
 *
 * @param document The document as it would be written.
 * @param previous The stored hash, or `undefined` if none is stored.
 * @param version The caller’s conversion version.
 * @throws {CanonicalizationLimitError} When the document is too costly to
 *   canonicalize.
 */
export async function detectChange(
  document: DatasetCore,
  previous: ContentHash | undefined,
  version: string,
): Promise<{ status: ChangeStatus; hash: ContentHash }> {
  const hash = { hash: await contentHash(document), version };
  if (previous === undefined) return { status: 'created', hash };
  if (previous.version !== version || !previous.hash.startsWith(`${method}:`)) {
    return { status: 'reconverted', hash };
  }
  if (previous.hash !== hash.hash) return { status: 'changed', hash };
  return { status: 'unchanged', hash };
}

const method = 'rdfc10-sha256';

async function contentHash(document: DatasetCore): Promise<string> {
  const content = [...document].filter(
    (quad) =>
      !quad.predicate.equals(contentHashPredicate) &&
      !quad.predicate.equals(hashVersionPredicate),
  );
  const canonical = await canonize(content.map(toCanonizeQuad), {
    algorithm: 'RDFC-1.0',
  }).catch((error: unknown) => {
    // rdf-canonize signals its work limit with a plain Error.
    if (
      error instanceof Error &&
      error.message.startsWith('Maximum deep iterations exceeded')
    ) {
      throw new CanonicalizationLimitError({ cause: error });
    }
    throw error;
  });
  return `${method}:${createHash('sha256').update(canonical).digest('hex')}`;
}

function toCanonizeQuad(quad: Quad) {
  return {
    subject: toCanonizeTerm(quad.subject),
    predicate: toCanonizeTerm(quad.predicate),
    object: toCanonizeTerm(quad.object),
    graph: toCanonizeTerm(quad.graph),
  };
}

// rdf-canonize expects blank node values with their `_:` prefix.
function toCanonizeTerm(term: Term) {
  return term.termType === 'BlankNode'
    ? { termType: 'BlankNode', value: `_:${term.value}` }
    : term;
}
