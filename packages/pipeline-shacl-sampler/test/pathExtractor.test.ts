import { describe, it, expect } from 'vitest';
import { join } from 'node:path';
import { extractTargetShapes, type TargetShape } from '../src/pathExtractor.js';

const shapesFile = join(__dirname, 'fixtures', 'schema-profile.ttl');

describe('extractTargetShapes', () => {
  it('returns one entry per sh:targetClass declared in the SHACL', async () => {
    const shapes = await extractTargetShapes(shapesFile);
    const classes = shapes.map((s) => s.targetClass.value).sort();
    expect(classes).toEqual([
      'https://schema.org/CreativeWork',
      'https://schema.org/Organization',
      'https://schema.org/Person',
      'https://schema.org/Place',
    ]);
  });

  it('emits a chain for every path whose constraint references a nested shape', async () => {
    const shapes = await extractTargetShapes(shapesFile);
    const creativeWork = findByClass(shapes, 'https://schema.org/CreativeWork');
    const top = topChains(creativeWork);

    // sh:or with sh:class/sh:node branches:
    expect(top).toContain('https://schema.org/creator');
    expect(top).toContain('https://schema.org/associatedMedia');
    expect(top).toContain('https://schema.org/contentLocation');
    expect(top).toContain('https://schema.org/locationCreated');
    expect(top).toContain('https://schema.org/about');
    expect(top).toContain('https://schema.org/identifier');
    // Direct sh:node:
    expect(top).toContain('https://schema.org/material');
    expect(top).toContain('https://schema.org/genre');
    expect(top).toContain('https://schema.org/dateCreated');
  });

  it('omits leaf paths (datatype / nodeKind only) from chains', async () => {
    const shapes = await extractTargetShapes(shapesFile);
    const creativeWork = findByClass(shapes, 'https://schema.org/CreativeWork');
    const top = topChains(creativeWork);

    // schema:name has only sh:datatype rdf:langString — leaf.
    expect(top).not.toContain('https://schema.org/name');
    expect(top).not.toContain('https://schema.org/description');
    expect(top).not.toContain('https://schema.org/abstract');
    // schema:isPartOf has only minCount — no value-shape ref.
    expect(top).not.toContain('https://schema.org/isPartOf');
  });

  it('extends chains recursively into nested shapes', async () => {
    const shapes = await extractTargetShapes(shapesFile);
    const creativeWork = findByClass(shapes, 'https://schema.org/CreativeWork');

    // CreativeWork.creator → CreatorShape.name is a leaf, but Person itself
    // has sh:targetClass Person so via sh:class Person we recurse:
    // creator → Person → birthPlace → Place → address (PostalAddress is
    // referenced via sh:node so we get this chain).
    expect(hasChain(creativeWork, ['creator', 'birthPlace', 'address'])).toBe(
      true,
    );
    // creator → Person → hasOccupation (sh:or contains sh:node):
    expect(hasChain(creativeWork, ['creator', 'hasOccupation'])).toBe(true);
  });

  it('handles self-cycles in the shape graph', async () => {
    // CreativeWork.about → sh:class CreativeWork → cycle back to
    // CreativeWorkShape. The extractor must terminate the recursion at
    // the second visit.
    const shapes = await extractTargetShapes(shapesFile);
    const creativeWork = findByClass(shapes, 'https://schema.org/CreativeWork');

    // The about hop itself must be present:
    expect(hasChain(creativeWork, ['about'])).toBe(true);
    // … but the recursion must not produce an infinite [about, about, …]:
    for (const chain of creativeWork.pathChains) {
      const aboutHops = chain.filter(
        (p) => p.value === 'https://schema.org/about',
      ).length;
      expect(aboutHops).toBeLessThanOrEqual(1);
    }
  });

  it('throws on unsupported sh:path forms (sequence/alternative/inverse)', async () => {
    await expect(
      extractTargetShapes(join(__dirname, 'fixtures', 'unsupported-path.ttl')),
    ).rejects.toThrow(/only plain IRI paths are supported/);
  });

  it('walks Place’s nested shape graph for the Place target', async () => {
    const shapes = await extractTargetShapes(shapesFile);
    const place = findByClass(shapes, 'https://schema.org/Place');
    // Place.address → PostalAddress has only leaf properties, so the chain
    // stops at [address]:
    expect(hasChain(place, ['address'])).toBe(true);
    // Place.geo → branches with sh:node and sh:class on GeoCoordinates /
    // GeoShape — at minimum [geo] must be present:
    expect(hasChain(place, ['geo'])).toBe(true);
  });
});

function findByClass(shapes: TargetShape[], iri: string): TargetShape {
  const shape = shapes.find((s) => s.targetClass.value === iri);
  if (!shape) throw new Error(`No shape found for ${iri}`);
  return shape;
}

function topChains(shape: TargetShape): string[] {
  return shape.pathChains
    .filter((chain) => chain.length === 1)
    .map((chain) => chain[0].value);
}

function hasChain(shape: TargetShape, localNames: string[]): boolean {
  const expected = localNames.map((name) => `https://schema.org/${name}`);
  return shape.pathChains.some(
    (chain) =>
      chain.length === expected.length &&
      chain.every((node, i) => node.value === expected[i]),
  );
}
