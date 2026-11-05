import { isImageService as isKnownImageService } from '@iiif/parser/image-3';
import { convertPresentation2 } from '@iiif/parser/presentation-2';
import { isPositiveInteger } from './isPositiveInteger.js';
import { serviceBase } from './serviceBase.js';

/** An image a manifest paints on a canvas. */
export interface PaintedImage {
  /** The image resource’s `id`. */
  url: string;
  /** The width the manifest states, if it states one as a positive integer. */
  width?: number;
  /** The height the manifest states, if it states one as a positive integer. */
  height?: number;
  /**
   * The base of the image’s image service, without a trailing slash or
   * `/info.json`, if the image has one. An image without one is a static file:
   * the only version there is, which cannot be resized.
   */
  service?: string;
}

/**
 * The images a manifest paints, in Presentation 2 or 3, in the order the
 * manifest paints them, whether or not they have an image service. Take the
 * first for a cover image: the canvases after it are not walked. A Presentation
 * 2 manifest is upgraded whole first, so it costs the same either way.
 *
 * Tolerant by design: it walks the plain JSON rather than normalising it, so a
 * manifest with a structural defect elsewhere – `"annotations": [null]`, which
 * viewers built on `@iiif/parser` reject outright – still yields its images.
 *
 * @throws {TypeError} when the document is not a manifest that can be read: one
 *   without canvases, such as an error page served as JSON, or a Presentation 2
 *   manifest the upgrade rejects. Unlike a manifest without images, that is not
 *   a fact about the manifest’s images worth keeping.
 */
export function images(manifest: unknown): IterableIterator<PaintedImage> {
  const document = upgraded(manifest);
  const canvases = arrayOf(fieldOf(document, 'items')).filter(
    (item) => fieldOf(item, 'type') === 'Canvas',
  );
  if (canvases.length === 0) {
    throw new TypeError('not a IIIF manifest: it has no canvases');
  }
  return imagesOf(canvases);
}

function* imagesOf(canvases: unknown[]): Generator<PaintedImage> {
  for (const canvas of canvases) {
    for (const page of arrayOf(fieldOf(canvas, 'items'))) {
      for (const annotation of arrayOf(fieldOf(page, 'items'))) {
        for (const body of paintedResources(fieldOf(annotation, 'body'))) {
          const image = paintedImageOf(body);
          if (image !== undefined) {
            yield image;
          }
        }
      }
    }
  }
}

/** The resource as a painted image, if it is an image or has an image service,
 *  and states its `id`. */
function paintedImageOf(resource: unknown): PaintedImage | undefined {
  const url = fieldOf(resource, 'id') ?? fieldOf(resource, '@id');
  const service = imageServiceOf(resource);
  if (
    typeof url !== 'string' ||
    (!isImage(resource) && service === undefined)
  ) {
    return undefined;
  }
  const width = fieldOf(resource, 'width');
  const height = fieldOf(resource, 'height');
  return {
    url,
    ...(isPositiveInteger(width) && { width }),
    ...(isPositiveInteger(height) && { height }),
    ...(service !== undefined && { service }),
  };
}

/** Whether the resource is typed as an image, in the Presentation 3 form or in
 *  the Presentation 2 forms some Presentation 3 manifests keep. */
function isImage(resource: unknown): boolean {
  const type = fieldOf(resource, 'type') ?? fieldOf(resource, '@type');
  return type === 'Image' || type === 'dctypes:Image';
}

/**
 * The manifest in Presentation 3 terms. The upgrade rewrites its input in place,
 * so it gets a copy: the caller’s manifest stays as it was, and a second call
 * reads it the same way.
 *
 * @throws {TypeError} when the upgrade rejects the manifest.
 */
function upgraded(manifest: unknown): unknown {
  if (fieldOf(manifest, 'sequences') === undefined) {
    return manifest;
  }
  try {
    return convertPresentation2(structuredClone(manifest) as object);
  } catch (error) {
    throw new TypeError('not a readable IIIF Presentation 2 manifest', {
      cause: error,
    });
  }
}

/** A body’s resources in order, with each `Choice` opened up and each
 *  `SpecificResource`, which is how a cropped painting is stated, unwrapped. */
function paintedResources(body: unknown): unknown[] {
  return arrayOf(body).flatMap((resource) => {
    const type = fieldOf(resource, 'type');
    if (type === 'Choice') {
      return paintedResources(fieldOf(resource, 'items'));
    }
    return type === 'SpecificResource'
      ? paintedResources(fieldOf(resource, 'source'))
      : [resource];
  });
}

function imageServiceOf(resource: unknown): string | undefined {
  for (const service of arrayOf(fieldOf(resource, 'service'))) {
    const id = fieldOf(service, 'id') ?? fieldOf(service, '@id');
    if (typeof id === 'string' && isImageService(service)) {
      return serviceBase(id);
    }
  }
  return undefined;
}

/**
 * The parser’s test, plus the two forms it misses: a `type` with no `profile`,
 * and a profile merely naming a compliance level, such as the `https` form of the
 * Stanford Image API 1.1 URL.
 */
function isImageService(service: unknown): boolean {
  const type = fieldOf(service, 'type') ?? fieldOf(service, '@type');
  const profile = fieldOf(service, 'profile');
  return (
    isKnownImageService(service as never) ||
    (typeof type === 'string' && type.startsWith('ImageService')) ||
    (typeof profile === 'string' && /level[012]/.test(profile))
  );
}

function fieldOf(value: unknown, name: string): unknown {
  return typeof value === 'object' && value !== null
    ? (value as Record<string, unknown>)[name]
    : undefined;
}

function arrayOf(value: unknown): unknown[] {
  if (value === undefined || value === null) {
    return [];
  }
  return Array.isArray(value) ? value : [value];
}
