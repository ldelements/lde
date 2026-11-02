import { describe, expect, it } from 'vitest';
import { imageUrl, readImageService } from '../src/index.js';

const URL = 'https://example.org/iiif/image';

describe('readImageService', () => {
  it('reads the live level-2 service’s dimensions, limits and listed sizes', () => {
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
      version: 3,
      level: 2,
      width: 1335,
      height: 2750,
      maxArea: 3671250,
      sizes: [
        { width: 83, height: 172, source: 'listed' },
        { width: 668, height: 1375, source: 'listed' },
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

    expect(service).toMatchObject({ version: 2, level: 1, maxWidth: 300 });
  });

  it('derives sizes from the tile scale factors, rounded as servers list them', () => {
    const service = readImageService(URL, {
      type: 'ImageService3',
      profile: 'level1',
      width: 1335,
      height: 2750,
      tiles: [{ width: 512, scaleFactors: [1, 2, 4, 8, 16] }],
    });

    expect(service?.sizes).toEqual(
      [
        [83, 172],
        [167, 344],
        [334, 688],
        [668, 1375],
        [1335, 2750],
      ].map(([width, height]) => ({ width, height, source: 'tiles' })),
    );
  });

  it('halves the full image where the server states neither sizes nor tiles', () => {
    const service = readImageService(URL, {
      type: 'ImageService3',
      profile: 'level2',
      width: 800,
      height: 600,
    });

    expect(service?.sizes.map(({ width, source }) => [width, source])).toEqual([
      [100, 'halving'],
      [200, 'halving'],
      [400, 'halving'],
      [800, 'halving'],
    ]);
  });

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
  ])('recognises Image API 1 by %s', (_how, shape) => {
    expect(
      readImageService(URL, { width: 800, height: 600, ...shape })?.version,
    ).toBe(1);
  });

  it.each([
    ['an ImageService2 type', { type: 'ImageService2' }, 2],
    [
      'an Image API 3 context without a type',
      { '@context': 'http://iiif.io/api/image/3/context.json' },
      3,
    ],
  ] as const)('reads the version from %s', (_how, shape, version) => {
    expect(
      readImageService(URL, { width: 800, height: 600, ...shape })?.version,
    ).toBe(version);
  });

  it('leaves the level undefined where the profile states none', () => {
    expect(
      readImageService(URL, {
        type: 'ImageService3',
        profile: { supports: [] },
        width: 800,
        height: 600,
      })?.level,
    ).toBeUndefined();
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

describe('imageUrl', () => {
  const size = { width: 83, height: 172 };

  it.each([
    [3, `${URL}/full/83,172/0/default.jpg`],
    [2, `${URL}/full/83,/0/default.jpg`],
    [1, `${URL}/full/83,/0/native.jpg`],
  ] as const)('builds the canonical form for version %i', (version, url) => {
    expect(imageUrl({ url: URL, version }, size)).toBe(url);
  });

  it('takes another format', () => {
    expect(imageUrl({ url: URL, version: 3 }, size, 'webp')).toBe(
      `${URL}/full/83,172/0/default.webp`,
    );
  });
});
