import { DataFactory, Store } from 'n3';
import { hydra, rdf } from '@tpluscode/rdf-ns-builders';

const { blankNode, literal } = DataFactory;

/**
 * Serialize a Hydra error as compact JSON-LD without needing the `jsonld` dependency.
 */
export function serializeHydraErrorAsJsonLd(
  title: string,
  description?: string,
): string {
  const obj: Record<string, string> = {
    '@context': 'http://www.w3.org/ns/hydra/core#',
    '@type': 'Error',
    title,
  };
  if (description !== undefined) {
    obj['description'] = description;
  }
  return JSON.stringify(obj);
}

/**
 * Create an N3 Store with Hydra error triples.
 */
export function createHydraErrorDataset(
  title: string,
  description?: string,
): Store {
  const store = new Store();
  const subject = blankNode();
  store.add(DataFactory.quad(subject, rdf.type, hydra.Error));
  store.add(DataFactory.quad(subject, hydra.title, literal(title)));
  if (description !== undefined) {
    store.add(
      DataFactory.quad(subject, hydra.description, literal(description)),
    );
  }
  return store;
}
