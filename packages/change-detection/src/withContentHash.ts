import type { DatasetCore, NamedNode } from '@rdfjs/types';
import { DataFactory, Store } from 'n3';
import type { ContentHash } from './detectChange.js';
import { contentHashPredicate, hashVersionPredicate } from './vocabulary.js';

const { literal, quad } = DataFactory;

/**
 * Return a copy of the document with its content hash added as two triples on
 * `iri`, in the default graph, replacing any hash triples `iri` already has
 * (as in a document read back from the store): write this copy, in one
 * update, instead of the
 * document itself, so the stored hash always matches the stored data.
 *
 * @param document The document as it would be written.
 * @param iri The document’s own IRI: the subject the hash is stored on, and
 *   the key {@link SparqlContentHashReader.read} looks it up by.
 * @param hash The hash {@link detectChange} returned for this document.
 */
export function withContentHash(
  document: DatasetCore,
  iri: NamedNode,
  hash: ContentHash,
): DatasetCore {
  const written: DatasetCore = new Store([...document]);
  for (const predicate of [contentHashPredicate, hashVersionPredicate]) {
    for (const existing of [...written.match(iri, predicate)]) {
      written.delete(existing);
    }
  }
  written.add(quad(iri, contentHashPredicate, literal(hash.hash)));
  written.add(quad(iri, hashVersionPredicate, literal(hash.version)));
  return written;
}
