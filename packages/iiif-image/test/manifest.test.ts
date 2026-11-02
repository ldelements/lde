import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { firstImageService, hasCanvases } from '../src/index.js';

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

describe('firstImageService', () => {
  it.each([
    // Presentation 2, with a static manifest thumbnail that has no service.
    ['gouda', 'https://www.goudatijdmachine.nl/omeka/iiif/2/98634'],
    // Presentation 2, with a service URL carrying a query string and the
    // `https` Stanford Image API 1.1 profile.
    [
      'limb',
      'https://demo.limb-gallery.com/i/?IIIF=/7b/2e/bc/4c/7b2ebc4c-1a55-4d5d-a154-8b590764caa6/iiif/Van_Gogh_-_Starry_Night_-_Google_Art_Project.tif',
    ],
    // Presentation 3, on another host than the manifest.
    ['ark11978', 'https://ndeiiif.adlibhosting.com/iiif/3/Q110996022.43856'],
    // Presentation 3, with `"annotations": [null]`, which normalising parsers reject.
    ['fehac', 'https://fehac.hosting.deventit.net/IIIF/image/3.0/ic:158'],
  ])('finds the first painted image service of %s', (name, service) => {
    expect(firstImageService(fixture(name))).toBe(service);
  });

  it('looks inside a Choice', () => {
    expect(
      firstImageService(
        manifestPainting({
          type: 'Choice',
          items: [
            {
              type: 'Image',
              service: [
                { id: 'https://example.org/iiif/a', type: 'ImageService3' },
              ],
            },
          ],
        }),
      ),
    ).toBe('https://example.org/iiif/a');
  });

  it('looks inside a SpecificResource, as a cropped painting is stated', () => {
    expect(
      firstImageService(
        manifestPainting({
          type: 'SpecificResource',
          source: {
            type: 'Image',
            service: [
              { id: 'https://example.org/iiif/a', type: 'ImageService3' },
            ],
          },
        }),
      ),
    ).toBe('https://example.org/iiif/a');
  });

  it.each([
    ['a trailing slash', 'https://example.org/iiif/a/'],
    ['the info.json itself', 'https://example.org/iiif/a/info.json'],
  ])('normalises a service stated with %s', (_shape, id) => {
    expect(
      firstImageService(
        manifestPainting({
          type: 'Image',
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
          service: {
            '@id': 'https://example.org/iiif/a',
            '@context': 'http://iiif.io/api/image/2/context.json',
            profile: ['http://iiif.io/api/image/2/level2.json', {}],
          },
        }),
      ),
    ).toBe('https://example.org/iiif/a');
  });

  it('skips a painted image without a service', () => {
    expect(
      firstImageService({
        type: 'Manifest',
        items: [
          canvasPainting({ type: 'Image', id: 'https://example.org/a.jpg' }),
          canvasPainting({
            type: 'Image',
            service: [
              { id: 'https://example.org/iiif/b', type: 'ImageService2' },
            ],
          }),
        ],
      }),
    ).toBe('https://example.org/iiif/b');
  });

  it('ignores a service that is not an image service', () => {
    expect(
      firstImageService(
        manifestPainting({
          type: 'Image',
          service: [
            { id: 'https://example.org/auth', type: 'AuthProbeService2' },
          ],
        }),
      ),
    ).toBeUndefined();
  });

  it('finds nothing in a Presentation 2 manifest the upgrade rejects', () => {
    expect(
      firstImageService({
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
    ).toBeUndefined();
  });

  it('finds nothing in a manifest with no image service', () => {
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

  it('finds nothing in what is not a manifest', () => {
    expect(firstImageService({ hello: 'world' })).toBeUndefined();
    expect(firstImageService(null)).toBeUndefined();
  });
});

describe('hasCanvases', () => {
  it.each(['gouda', 'limb', 'ark11978', 'fehac'])(
    'is true of the %s manifest',
    (name) => {
      expect(hasCanvases(fixture(name))).toBe(true);
    },
  );

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
  ])('is false of %s', (_name, document) => {
    expect(hasCanvases(document)).toBe(false);
  });
});
