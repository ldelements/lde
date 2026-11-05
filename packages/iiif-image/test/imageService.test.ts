import { describe, expect, it } from 'vitest';
import { readImageService } from '../src/index.js';

const URL = 'https://example.org/iiif/image';

describe('readImageService', () => {
  it('reads the live level-2 service’s dimensions and listed sizes', () => {
    expect(
      readImageService(URL, {
        '@context': 'http://iiif.io/api/image/3/context.json',
        id: 'http://internal:8182/iiif/3/image',
        type: 'ImageService3',
        profile: 'level2',
        width: 1335,
        height: 2750,
        maxArea: 3671250,
        sizes: [
          { width: 668, height: 1375 },
          { width: 83, height: 172 },
        ],
      }),
    ).toEqual({
      url: URL,
      width: 1335,
      height: 2750,
      sizes: [
        { width: 83, height: 172, url: `${URL}/full/83,172/0/default.jpg` },
        {
          width: 668,
          height: 1375,
          url: `${URL}/full/668,1375/0/default.jpg`,
        },
      ],
    });
  });

  it('reads Image API 2 with its profile array and `iiif:Image` type', () => {
    const service = readImageService(URL, {
      '@context': 'http://iiif.io/api/image/2/context.json',
      '@id': URL,
      '@type': 'iiif:Image',
      profile: ['http://iiif.io/api/image/2/level1.json', { formats: ['png'] }],
      width: 400,
      height: 300,
      maxWidth: 300,
      sizes: [{ width: 200, height: 150 }],
    });

    expect(service?.sizes).toEqual([
      { width: 200, height: 150, url: `${URL}/full/200,/0/default.jpg` },
    ]);
  });

  it('derives sizes from the tile scale factors, rounded as servers list them', () => {
    const service = readImageService(URL, {
      type: 'ImageService3',
      profile: 'level1',
      width: 1335,
      height: 2750,
      tiles: [{ width: 512, scaleFactors: [1, 2, 4, 8, 16] }],
    });

    expect(service?.sizes.map(({ width, height }) => [width, height])).toEqual([
      [83, 172],
      [167, 344],
      [334, 688],
      [668, 1375],
      [1335, 2750],
    ]);
  });

  it.each([
    ['no tiles', {}],
    ['tiles without scale factors', { tiles: [{ width: 512 }] }],
  ])(
    'halves the full image where the server lists no sizes and states %s',
    (_shape, tiles) => {
      const service = readImageService(URL, {
        type: 'ImageService3',
        profile: 'level2',
        width: 800,
        height: 600,
        ...tiles,
      });

      expect(service?.sizes.map(({ width }) => width)).toEqual([
        100, 200, 400, 800,
      ]);
    },
  );

  it.each([
    ['maxWidth', { maxWidth: 400 }, [100, 200, 400]],
    ['maxHeight', { maxHeight: 150 }, [100, 200]],
    ['maxArea', { maxArea: 120000 }, [100, 200, 400]],
  ])(
    'leaves out derived sizes above the server’s %s',
    (_limit, limits, widths) => {
      const service = readImageService(URL, {
        type: 'ImageService3',
        profile: 'level2',
        width: 800,
        height: 600,
        ...limits,
      });

      expect(service?.sizes.map(({ width }) => width)).toEqual(widths);
    },
  );

  it('derives nothing for a level-0 server, which only serves what it lists', () => {
    expect(
      readImageService(URL, {
        type: 'ImageService3',
        profile: 'level0',
        width: 800,
        height: 600,
      })?.sizes,
    ).toEqual([]);
  });

  it('leaves out a derived size that rounds to no height', () => {
    const service = readImageService(URL, {
      type: 'ImageService3',
      profile: 'level2',
      width: 6400,
      height: 10,
      tiles: [{ width: 512, scaleFactors: [1, 32] }],
    });

    expect(service?.sizes.map(({ width }) => width)).toEqual([6400]);
  });

  it.each([
    [
      'its context',
      {
        '@context':
          'http://library.stanford.edu/iiif/image-api/1.1/context.json',
      },
    ],
    [
      'its profile, where it states no context',
      {
        profile:
          'http://library.stanford.edu/iiif/image-api/compliance.html#level1',
      },
    ],
  ])(
    'recognises Image API 1 by %s, and asks for its `native` quality',
    (_how, shape) => {
      expect(
        readImageService(URL, { width: 800, height: 600, ...shape })?.sizes[0]
          .url,
      ).toBe(`${URL}/full/100,/0/native.jpg`);
    },
  );

  it.each([
    [
      'version 2 from an ImageService2 type',
      { type: 'ImageService2' },
      `${URL}/full/100,/0/default.jpg`,
    ],
    [
      'version 3 from its context, without a type',
      { '@context': 'http://iiif.io/api/image/3/context.json' },
      `${URL}/full/100,75/0/default.jpg`,
    ],
    [
      'version 2, the most common, from nothing at all',
      {},
      `${URL}/full/100,/0/default.jpg`,
    ],
  ])('builds image URLs for %s', (_how, shape, url) => {
    expect(
      readImageService(URL, { width: 800, height: 600, ...shape })?.sizes[0]
        .url,
    ).toBe(url);
  });

  it('derives sizes where the profile states no level', () => {
    expect(
      readImageService(URL, {
        type: 'ImageService3',
        profile: { supports: [] },
        width: 800,
        height: 600,
      })?.sizes,
    ).toHaveLength(4);
  });

  it.each([
    ['null', null],
    ['no dimensions', { type: 'ImageService3' }],
    ['fractional dimensions', { width: 1335.5, height: 2750 }],
    ['zero dimensions', { width: 0, height: 2750 }],
  ])('answers nothing for %s', (_name, info) => {
    expect(readImageService(URL, info)).toBeUndefined();
  });
});

describe('readImageService’s URL', () => {
  it.each([`${URL}/`, `${URL}/info.json`])(
    'is the base URL, whatever form it is given in: %s',
    (given) => {
      expect(
        readImageService(given, { type: 'ImageService3', width: 8, height: 6 })
          ?.url,
      ).toBe(URL);
    },
  );
});
