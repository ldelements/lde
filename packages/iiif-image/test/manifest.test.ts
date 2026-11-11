import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { images } from '../src/index.js';

function fixture(name: string): unknown {
  return JSON.parse(
    readFileSync(new URL(`fixtures/${name}.json`, import.meta.url), 'utf8'),
  );
}

function canvasPainting(body: unknown): unknown {
  return {
    type: 'Canvas',
    items: [{ type: 'AnnotationPage', items: [{ type: 'Annotation', body }] }],
  };
}

function manifestPainting(body: unknown): unknown {
  return { type: 'Manifest', items: [canvasPainting(body)] };
}

function firstImageService(manifest: unknown): string | undefined {
  const [first] = images(manifest);
  return first?.service;
}

describe('images', () => {
  it.each([
    // Presentation 2, with a static manifest thumbnail that has no service.
    [
      'gouda',
      {
        url: 'https://www.goudatijdmachine.nl/omeka/iiif/2/98634/full/800,600/0/default.jpg',
        width: 5184,
        height: 3888,
        service: 'https://www.goudatijdmachine.nl/omeka/iiif/2/98634',
      },
    ],
    // Presentation 2, with a service URL carrying a query string and the
    // `https` Stanford Image API 1.1 profile.
    [
      'limb',
      {
        url: 'https://demo.limb-gallery.com/i/?IIIF=/7b/2e/bc/4c/7b2ebc4c-1a55-4d5d-a154-8b590764caa6/iiif/Van_Gogh_-_Starry_Night_-_Google_Art_Project.tif/full/full/0/default.jpg',
        width: 30000,
        height: 23756,
        service:
          'https://demo.limb-gallery.com/i/?IIIF=/7b/2e/bc/4c/7b2ebc4c-1a55-4d5d-a154-8b590764caa6/iiif/Van_Gogh_-_Starry_Night_-_Google_Art_Project.tif',
      },
    ],
    // Presentation 3, on another host than the manifest, stating no size.
    [
      'ark11978',
      {
        url: 'https://n2t.net/ark:/11978/519a1270ffdd465caee2de9c205973eb/iiif.json#/canvas/1/body/1',
        service: 'https://ndeiiif.adlibhosting.com/iiif/3/Q110996022.43856',
      },
    ],
    // Presentation 3, with `"annotations": [null]`, which normalising parsers reject.
    [
      'fehac',
      {
        url: 'https://fehac.hosting.deventit.net/IIIF/image/3.0/ic:158/full/max/0/default.jpg',
        width: 200,
        height: 132,
        service: 'https://fehac.hosting.deventit.net/IIIF/image/3.0/ic:158',
      },
    ],
  ])('finds the first painted image of %s', (name, image) => {
    const [first] = images(fixture(name));
    expect(first).toEqual(image);
  });

  it('looks inside a Choice', () => {
    expect([
      ...images(
        manifestPainting({
          type: 'Choice',
          items: [
            {
              type: 'Image',
              id: 'https://example.org/a',
              service: [
                { id: 'https://example.org/iiif/a', type: 'ImageService3' },
              ],
            },
          ],
        }),
      ),
    ]).toEqual([
      { url: 'https://example.org/a', service: 'https://example.org/iiif/a' },
    ]);
  });

  it('looks inside a SpecificResource, as a cropped painting is stated', () => {
    expect([
      ...images(
        manifestPainting({
          type: 'SpecificResource',
          source: {
            type: 'Image',
            id: 'https://example.org/a',
            service: [
              { id: 'https://example.org/iiif/a', type: 'ImageService3' },
            ],
          },
        }),
      ),
    ]).toEqual([
      { url: 'https://example.org/a', service: 'https://example.org/iiif/a' },
    ]);
  });

  it.each([
    ['a prefixed type', { type: 'dctypes:Image' }],
    ['an @type', { '@type': 'Image' }],
  ])('recognises a static image stated with %s', (_shape, type) => {
    expect([
      ...images(manifestPainting({ id: 'https://example.org/a.jpg', ...type })),
    ]).toEqual([{ url: 'https://example.org/a.jpg' }]);
  });

  it.each([
    ['a trailing slash', 'https://example.org/iiif/a/'],
    ['the info.json itself', 'https://example.org/iiif/a/info.json'],
  ])('normalises a service stated with %s', (_shape, id) => {
    expect(
      firstImageService(
        manifestPainting({
          type: 'Image',
          id: 'https://example.org/a',
          service: [{ id, type: 'ImageService3' }],
        }),
      ),
    ).toBe('https://example.org/iiif/a');
  });

  it('recognises an untyped service by the array form of its profile', () => {
    expect(
      firstImageService(
        manifestPainting({
          type: 'Image',
          id: 'https://example.org/a',
          service: {
            '@id': 'https://example.org/iiif/a',
            '@context': 'http://iiif.io/api/image/2/context.json',
            profile: ['http://iiif.io/api/image/2/level2.json', {}],
          },
        }),
      ),
    ).toBe('https://example.org/iiif/a');
  });

  it('yields every painted image in order, with its service if it has one', () => {
    expect([
      ...images({
        type: 'Manifest',
        items: [
          canvasPainting({
            type: 'Image',
            id: 'https://example.org/a',
            service: [
              { id: 'https://example.org/iiif/a', type: 'ImageService3' },
            ],
          }),
          canvasPainting({ type: 'Image', id: 'https://example.org/b.jpg' }),
          canvasPainting({
            type: 'Image',
            id: 'https://example.org/c',
            service: [
              { id: 'https://example.org/iiif/c', type: 'ImageService2' },
            ],
          }),
        ],
      }),
    ]).toEqual([
      { url: 'https://example.org/a', service: 'https://example.org/iiif/a' },
      { url: 'https://example.org/b.jpg' },
      { url: 'https://example.org/c', service: 'https://example.org/iiif/c' },
    ]);
  });

  it('ignores a service that is not an image service', () => {
    expect(
      firstImageService(
        manifestPainting({
          type: 'Image',
          id: 'https://example.org/a',
          service: [
            { id: 'https://example.org/auth', type: 'AuthProbeService2' },
          ],
        }),
      ),
    ).toBeUndefined();
  });

  it('yields a static image with the size the manifest states', () => {
    expect([
      ...images(
        manifestPainting({
          id: 'https://example.org/a.jpg',
          type: 'Image',
          format: 'image/jpeg',
          width: 1466,
          height: 2000,
        }),
      ),
    ]).toEqual([
      { url: 'https://example.org/a.jpg', width: 1466, height: 2000 },
    ]);
  });

  it('yields the stated size of an image with a service', () => {
    expect([
      ...images(
        manifestPainting({
          id: 'https://example.org/a.jpg',
          type: 'Image',
          width: 800,
          height: 600,
          service: [
            { id: 'https://example.org/iiif/a', type: 'ImageService3' },
          ],
        }),
      ),
    ]).toEqual([
      {
        url: 'https://example.org/a.jpg',
        width: 800,
        height: 600,
        service: 'https://example.org/iiif/a',
      },
    ]);
  });

  it('yields a static image from a Presentation 2 manifest', () => {
    expect([
      ...images({
        '@context': 'http://iiif.io/api/presentation/2/context.json',
        '@id': 'https://example.org/manifest',
        '@type': 'sc:Manifest',
        sequences: [
          {
            '@type': 'sc:Sequence',
            canvases: [
              {
                '@id': 'https://example.org/canvas',
                '@type': 'sc:Canvas',
                width: 1466,
                height: 2000,
                images: [
                  {
                    '@type': 'oa:Annotation',
                    motivation: 'sc:painting',
                    on: 'https://example.org/canvas',
                    resource: {
                      '@id': 'https://example.org/a.jpg',
                      '@type': 'dctypes:Image',
                      format: 'image/jpeg',
                      width: 1466,
                      height: 2000,
                    },
                  },
                ],
              },
            ],
          },
        ],
      }),
    ]).toEqual([
      { url: 'https://example.org/a.jpg', width: 1466, height: 2000 },
    ]);
  });

  it.each([
    ['zero', 0],
    ['negative', -1],
    ['fractional', 1.5],
    ['a string', '1466'],
  ])('leaves out a stated size that is %s', (_shape, size) => {
    expect([
      ...images(
        manifestPainting({
          id: 'https://example.org/a.jpg',
          type: 'Image',
          width: size,
          height: size,
        }),
      ),
    ]).toEqual([{ url: 'https://example.org/a.jpg' }]);
  });

  it('skips a painted resource that is not an image', () => {
    expect([
      ...images(
        manifestPainting({ id: 'https://example.org/a.mp4', type: 'Video' }),
      ),
    ]).toEqual([]);
  });

  it('skips an image without an id', () => {
    expect([...images(manifestPainting({ type: 'Image' }))]).toEqual([]);
  });

  it('throws for a Presentation 2 manifest the upgrade rejects', () => {
    expect(() =>
      images({
        '@context': 'http://iiif.io/api/presentation/2/context.json',
        '@id': 'https://example.org/manifest',
        '@type': 'sc:Manifest',
        sequences: [
          {
            '@type': 'sc:Sequence',
            canvases: [
              {
                '@id': 'https://example.org/canvas',
                '@type': 'sc:Canvas',
                images: [null],
              },
            ],
          },
        ],
      }),
    ).toThrow('not a readable IIIF Presentation 2 manifest');
  });

  it('yields no service for an image without one', () => {
    expect(
      firstImageService(
        manifestPainting({ type: 'Image', id: 'https://example.org/a.jpg' }),
      ),
    ).toBeUndefined();
  });

  it('leaves the caller’s Presentation 2 manifest as it was', () => {
    const manifest = fixture('gouda');
    const before = structuredClone(manifest);

    const first = firstImageService(manifest);

    expect(manifest).toEqual(before);
    expect(firstImageService(manifest)).toBe(first);
  });

  it.each([
    ['an error object', { error: 'down for maintenance' }],
    ['a manifest without canvases', { type: 'Manifest', items: [] }],
    [
      'a collection of manifests',
      {
        type: 'Collection',
        items: [{ id: 'https://example.org/m', type: 'Manifest' }],
      },
    ],
    [
      'a Presentation 2 sequence without canvases',
      { sequences: [{ canvases: [] }] },
    ],
    ['null', null],
  ])('throws for %s, which is not a usable manifest', (_name, document) => {
    expect(() => images(document)).toThrow(TypeError);
  });
});
