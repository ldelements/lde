import { applyNamespaceAliases, type NamespaceAlias } from '../src/index.js';
import { QueryEngine } from '@comunica/query-sparql-rdfjs-lite';
import { Store, DataFactory } from 'n3';
import type { Quad } from '@rdfjs/types';
import { readFile } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it, expect, beforeAll } from 'vitest';

const { namedNode, literal } = DataFactory;

const VOID = 'http://rdfs.org/ns/void#';
const RDF_TYPE = 'http://www.w3.org/1999/02/22-rdf-syntax-ns#type';

const schemaOrg: NamespaceAlias[] = [
  { canonical: 'https://schema.org/', alias: 'http://schema.org/' },
];

const queriesDir = resolve(
  dirname(fileURLToPath(import.meta.url)),
  '..',
  'queries',
);

/**
 * A store mixing `http://schema.org/` and `https://schema.org/` types for the
 * same conceptual class — three CreativeWorks typed with the http variant and
 * two with the https variant — the shape that produced duplicate
 * `void:classPartition` nodes before canonicalisation.
 */
function mixedNamespaceStore(): Store {
  const store = new Store();
  const type = namedNode(RDF_TYPE);
  for (let index = 0; index < 3; index++) {
    const subject = namedNode(`urn:http:${index}`);
    store.addQuad(subject, type, namedNode('http://schema.org/CreativeWork'));
    store.addQuad(subject, namedNode('http://schema.org/name'), literal('a'));
  }
  for (let index = 0; index < 2; index++) {
    const subject = namedNode(`urn:https:${index}`);
    store.addQuad(subject, type, namedNode('https://schema.org/CreativeWork'));
    store.addQuad(
      subject,
      namedNode('https://schema.org/encodingFormat'),
      literal('b'),
    );
  }
  return store;
}

async function runQuery(
  file: string,
  store: Store,
  subjectFilter: string,
): Promise<Quad[]> {
  const query = applyNamespaceAliases(
    await readFile(resolve(queriesDir, file), 'utf-8'),
    schemaOrg,
  )
    .replaceAll('#subjectFilter#', subjectFilter)
    .replaceAll('?dataset', '<urn:dataset>');

  const result: Quad[] = [];
  const stream = await new QueryEngine().queryQuads(query, {
    sources: [store],
  });
  for await (const quad of stream) result.push(quad);
  return result;
}

const objectsOf = (quads: Quad[], predicate: string): string[] =>
  quads
    .filter((quad) => quad.predicate.value === predicate)
    .map((quad) => quad.object.value);

describe('class partition deduplication across namespace aliases', () => {
  beforeAll(() => {
    // The Comunica engine pulls in many modules; give the first import room.
  });

  it('emits a single class partition with summed entities', async () => {
    const quads = await runQuery(
      'class-partition.rq',
      mixedNamespaceStore(),
      '',
    );

    expect(objectsOf(quads, `${VOID}class`)).toEqual([
      'https://schema.org/CreativeWork',
    ]);
    // 3 http-typed + 2 https-typed resources, summed into one partition.
    expect(objectsOf(quads, `${VOID}entities`)).toEqual(['5']);
  });

  it('counts both namespace variants under the canonical class partition', async () => {
    // The selector injects the canonical class; the query must still match the
    // alias-typed resources.
    const quads = await runQuery(
      'class-properties-subjects.rq',
      mixedNamespaceStore(),
      'VALUES ?class { <https://schema.org/CreativeWork> }',
    );

    expect(new Set(objectsOf(quads, `${VOID}class`))).toEqual(
      new Set(['https://schema.org/CreativeWork']),
    );
    // Properties from both the http and https subsets attach to the one class.
    expect(objectsOf(quads, `${VOID}property`)).toEqual(
      expect.arrayContaining([
        'http://schema.org/name',
        'https://schema.org/encodingFormat',
      ]),
    );
  });
});
