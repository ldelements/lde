import { Parser, Store } from 'n3';
import { describe, expect, it } from 'vitest';
import { detectChange } from '../src/index.js';

const version = 'conversion-1';

function parse(turtle: string): Store {
  return new Store(
    new Parser().parse(`@prefix ex: <https://example.org/> .\n${turtle}`),
  );
}

describe('detectChange', () => {
  it('returns unchanged for a document whose hash and version are stored', async () => {
    const document = parse('ex:dataset ex:title "A" .');
    const first = await detectChange(document, undefined, version);

    const second = await detectChange(document, first.hash, version);

    expect(second.status).toBe('unchanged');
  });

  it('returns changed for different content under the same version', async () => {
    const { hash } = await detectChange(
      parse('ex:dataset ex:title "A" .'),
      undefined,
      version,
    );

    const result = await detectChange(
      parse('ex:dataset ex:title "B" .'),
      hash,
      version,
    );

    expect(result.status).toBe('changed');
  });

  it.each([
    ['the same content', 'ex:dataset ex:title "A" .'],
    ['different content', 'ex:dataset ex:title "B" .'],
  ])('returns reconverted for a new version with %s', async (_, turtle) => {
    const { hash } = await detectChange(
      parse('ex:dataset ex:title "A" .'),
      undefined,
      version,
    );

    const result = await detectChange(parse(turtle), hash, 'conversion-2');

    expect(result.status).toBe('reconverted');
    expect(result.hash.version).toBe('conversion-2');
  });

  it('returns reconverted for a hash stored by another hashing method', async () => {
    const document = parse('ex:dataset ex:title "A" .');
    const { hash } = await detectChange(document, undefined, version);
    const digest = hash.hash.slice(hash.hash.indexOf(':') + 1);

    const result = await detectChange(
      document,
      { hash: `older-method:${digest}`, version },
      version,
    );

    expect(result.status).toBe('reconverted');
  });

  it('throws for a document too costly to canonicalize', async () => {
    // Every blank node links to every other: all are indistinguishable.
    const labels = Array.from({ length: 10 }, (_, index) => `_:b${index}`);
    const poison = labels
      .flatMap((from) =>
        labels.filter((to) => to !== from).map((to) => `${from} ex:p ${to} .`),
      )
      .join('\n');

    await expect(
      detectChange(parse(poison), undefined, version),
    ).rejects.toThrow();
  });

  it('returns unchanged when only blank node labels differ', async () => {
    const turtle =
      'ex:dataset ex:distribution [ ex:url ex:a ], [ ex:url ex:b ] .';
    const first = parse(turtle);
    const reparsed = parse(turtle);
    expect(blankNodeLabels(reparsed)).not.toEqual(blankNodeLabels(first));
    const { hash } = await detectChange(first, undefined, version);

    const result = await detectChange(reparsed, hash, version);

    expect(result.status).toBe('unchanged');
  });
});

function blankNodeLabels(document: Store): string[] {
  return [...document]
    .filter((quad) => quad.object.termType === 'BlankNode')
    .map((quad) => quad.object.value);
}
