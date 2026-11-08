import { DataFactory, Parser, Store } from 'n3';
import { describe, expect, it } from 'vitest';
import { detectChange, withContentHash } from '../src/index.js';

const { namedNode, literal, quad, defaultGraph } = DataFactory;
const contentHash = 'https://w3id.org/lde/content-hash#';
const iri = namedNode('https://example.org/dataset');
const version = 'conversion-1';

function parse(turtle: string): Store {
  return new Store(
    new Parser().parse(`@prefix ex: <https://example.org/> .\n${turtle}`),
  );
}

describe('withContentHash', () => {
  it('adds the hash and version on the IRI, in the default graph', async () => {
    const document = parse('ex:dataset ex:title "A" .');
    const { hash } = await detectChange(document, undefined, version);

    const written = withContentHash(document, iri, hash);

    expect(written.size).toBe(3);
    expect(
      written.has(
        quad(
          iri,
          namedNode(`${contentHash}contentHash`),
          literal(hash.hash),
          defaultGraph(),
        ),
      ),
    ).toBe(true);
    expect(
      written.has(
        quad(
          iri,
          namedNode(`${contentHash}hashVersion`),
          literal(version),
          defaultGraph(),
        ),
      ),
    ).toBe(true);
    expect(document.size).toBe(1);
  });

  it('writes a document that hashes the same as without the hash triples', async () => {
    const document = parse('ex:dataset ex:title "A" .');
    const { hash } = await detectChange(document, undefined, version);
    const readBack = withContentHash(document, iri, hash);

    const result = await detectChange(readBack, hash, version);

    expect(result.status).toBe('unchanged');
  });

  it('replaces the hash of a document read back from the store', async () => {
    const original = parse('ex:dataset ex:title "A" .');
    const { hash: oldHash } = await detectChange(original, undefined, version);
    const readBack = withContentHash(original, iri, oldHash);
    readBack.add(
      quad(iri, namedNode('https://example.org/title'), literal('B')),
    );
    const { hash } = await detectChange(readBack, oldHash, version);

    const written = withContentHash(readBack, iri, hash);

    expect(
      written.match(iri, namedNode(`${contentHash}contentHash`)).size,
    ).toBe(1);
    expect(
      written.match(iri, namedNode(`${contentHash}hashVersion`)).size,
    ).toBe(1);
  });
});
