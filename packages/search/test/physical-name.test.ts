import { describe, expect, it } from 'vitest';
import type { SearchType } from '../src/schema.js';
import { physicalNameTokens } from '../src/physical-name.js';

const typeNamed = (name: string): SearchType => ({
  name,
  class: 'https://example.org/Thing',
  fields: [],
});

const tokensOf = (name: string): readonly string[] =>
  physicalNameTokens(typeNamed(name));

describe('physicalNameTokens', () => {
  it('splits a PascalCase name into lowercase words and pluralizes the last', () => {
    expect(tokensOf('CreativeWork')).toEqual(['creative', 'works']);
  });

  it('pluralizes a single-word name', () => {
    expect(tokensOf('Dataset')).toEqual(['datasets']);
  });

  it.each([
    // The names the engines’ own docs use, which is the convention this
    // implements: https://typesense.org/docs/guide/organizing-collections.html
    ['BlogArticle', ['blog', 'articles']],
    ['Company', ['companies']],
    ['Person', ['people']],
  ])('matches the engine docs’ own naming for %s', (name, expected) => {
    expect(tokensOf(name)).toEqual(expected);
  });

  it.each([
    // A real inflector, so these land as English rather than as the non-words
    // regular rules give (`serieses`, `analysises`, `criterions`).
    ['TVSeries', ['tv', 'series']],
    ['Analysis', ['analyses']],
    ['Criterion', ['criteria']],
  ])('inflects the irregular/invariant noun %s', (name, expected) => {
    expect(tokensOf(name)).toEqual(expected);
  });

  it.each([
    // Splitting on every capital would give `d_c_a_t_datasets` / `t_v_series`;
    // acronyms are everywhere in RDF vocabularies, so they stay whole.
    ['DCATDataset', ['dcat', 'datasets']],
    ['HTTPEndpoint', ['http', 'endpoints']],
    ['IIIFManifest', ['iiif', 'manifests']],
  ])('keeps the acronym in %s whole', (name, expected) => {
    expect(tokensOf(name)).toEqual(expected);
  });

  it('is idempotent for an already-plural name', () => {
    expect(tokensOf('People')).toEqual(['people']);
  });

  it('tokenizes camelCase and separator-written names the same way', () => {
    for (const name of ['creativeWork', 'creative_work', 'creative-work']) {
      expect(tokensOf(name)).toEqual(['creative', 'works']);
    }
  });

  it('keeps digits with the word they are attached to', () => {
    expect(tokensOf('Rfc9110Header')).toEqual(['rfc9110', 'headers']);
  });

  it.each(['Café', 'Musée', 'Straße', 'Creative@Work', 'Ω'])(
    'refuses to name %s rather than silently drop what it cannot spell',
    (name) => {
      // Unmatched characters are skipped, so these would otherwise yield a
      // legal name for the wrong container (`Café` gives `['cafs']`).
      expect(() => tokensOf(name)).toThrow(
        /carries characters outside ASCII words and word separators/,
      );
    },
  );

  it.each(['---', '', '   '])(
    'refuses %s, which leaves no word to name anything after',
    (name) => {
      expect(() => tokensOf(name)).toThrow(
        /carries no word to name a container/,
      );
    },
  );

  it('leaves engine legality to the adapter, naming what it can spell', () => {
    // `123s` is spellable; whether a container may be named it is the
    // adapter’s rule, not this one’s.
    expect(tokensOf('123')).toEqual(['123s']);
  });
});
