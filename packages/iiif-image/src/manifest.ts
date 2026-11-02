import { isImageService as isKnownImageService } from '@iiif/parser/image-3';
import { convertPresentation2 } from '@iiif/parser/presentation-2';
import { serviceBase } from './serviceBase.js';

/**
 * The URL of the image service of a manifest’s first painted image that has one,
 * in Presentation 2 or 3, or `undefined` where no painted image has one.
 *
 * Tolerant by design: it walks the plain JSON rather than normalising it, so a
 * manifest with a structural defect elsewhere – `"annotations": [null]`, which
 * viewers built on `@iiif/parser` reject outright – still yields its service. A
 * Presentation 2 manifest the upgrade cannot read yields `undefined`.
 *
 * The URL is the service’s base, without a trailing slash or `/info.json`.
 */
export function firstImageService(manifest: unknown): string | undefined {
  for (const canvas of arrayOf(fieldOf(upgraded(manifest), 'items'))) {
    for (const page of arrayOf(fieldOf(canvas, 'items'))) {
      for (const annotation of arrayOf(fieldOf(page, 'items'))) {
        for (const body of paintedResources(fieldOf(annotation, 'body'))) {
          const service = imageServiceOf(body);
          if (service !== undefined) {
            return service;
          }
        }
      }
    }
  }
  return undefined;
}

/**
 * Whether a document has the canvases every manifest must have, in either
 * version. Tells a manifest without an image service apart from a document that
 * is not a usable manifest at all, such as an error page served as JSON.
 */
export function hasCanvases(document: unknown): boolean {
  const canvases3 = arrayOf(fieldOf(document, 'items')).filter(
    (item) => fieldOf(item, 'type') === 'Canvas',
  );
  const canvases2 = arrayOf(fieldOf(document, 'sequences')).flatMap(
    (sequence) => arrayOf(fieldOf(sequence, 'canvases')),
  );
  return canvases3.length > 0 || canvases2.length > 0;
}

/**
 * The manifest in Presentation 3 terms, or `undefined` where the upgrade fails.
 * The upgrade rewrites its input in place, so it gets a copy: the caller’s
 * manifest stays as it was, and a second call reads it the same way.
 */
function upgraded(manifest: unknown): unknown {
  if (fieldOf(manifest, 'sequences') === undefined) {
    return manifest;
  }
  try {
    return convertPresentation2(structuredClone(manifest) as object);
  } catch {
    return undefined;
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
