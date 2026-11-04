import { serviceBase } from './serviceBase.js';

/**
 * An image service as its `info.json` describes it, normalised across Image API
 * versions 1, 2 and 3.
 */
export interface ImageService {
  /** The service’s base URL, which `info.json` and image requests extend. */
  readonly url: string;
  /** The full image’s width in pixels. */
  readonly width: number;
  /** The full image’s height in pixels. */
  readonly height: number;
  /**
   * Whole-image JPEG renditions worth requesting, smallest first. Each `url` is
   * in the canonical form of the service’s API version, so that a server which
   * prepared the size finds it; JPEG is the one format every compliance level
   * must support.
   */
  readonly sizes: readonly {
    readonly width: number;
    readonly height: number;
    readonly url: string;
  }[];
}

/**
 * Read an `info.json` into an {@link ImageService}, or `undefined` where it does
 * not state the image’s dimensions as positive integers.
 *
 * `url` names the service rather than the document’s own `id`, because a server
 * behind a proxy may report an internal one.
 *
 * Sizes are the ones the server lists. Where it lists none, they are derived from
 * its tile scale factors, or by halving the full image, at least 64 pixels wide
 * and within the server’s declared limits. A level-0 server only serves what it
 * lists, so without a list it gets no sizes.
 */
export function readImageService(
  url: string,
  info: unknown,
): ImageService | undefined {
  if (typeof info !== 'object' || info === null) {
    return undefined;
  }
  const document = info as Record<string, unknown>;
  const { width, height } = document;
  if (!isPositiveInteger(width) || !isPositiveInteger(height)) {
    return undefined;
  }
  const profile = profileOf(document);
  const base = serviceBase(url);
  const version = versionOf(document, profile);
  return {
    url: base,
    width,
    height,
    sizes: sizesOf(document, width, height, levelOf(profile))
      .sort((left, right) => left.width - right.width)
      .map((size) => ({ ...size, url: imageUrl(base, version, size) })),
  };
}

/** The canonical URL of a whole-image JPEG rendition at `size`. */
function imageUrl(base: string, version: Version, size: Size): string {
  if (version === 3) {
    return `${base}/full/${size.width},${size.height}/0/default.jpg`;
  }
  // Image API 1 names the default quality `native`.
  const quality = version === 1 ? 'native' : 'default';
  return `${base}/full/${size.width},/0/${quality}.jpg`;
}

/** The Image API version a service speaks. */
type Version = 1 | 2 | 3;

interface Size {
  readonly width: number;
  readonly height: number;
}

/** Derived sizes narrower than this are not worth a request. */
const MINIMUM_DERIVED_WIDTH = 64;

function sizesOf(
  document: Record<string, unknown>,
  width: number,
  height: number,
  level: Level,
): Size[] {
  const listed = (Array.isArray(document.sizes) ? document.sizes : [])
    .filter(
      (size): size is { width: number; height: number } =>
        isPositiveInteger(size?.width) && isPositiveInteger(size?.height),
    )
    .map(({ width, height }) => ({ width, height }));
  if (listed.length > 0 || level === 0) {
    return listed;
  }
  const tileFactors = (Array.isArray(document.tiles) ? document.tiles : [])
    .flatMap((tile) =>
      Array.isArray(tile?.scaleFactors) ? tile.scaleFactors : [],
    )
    .filter(isPositiveInteger);
  const factors = tileFactors.length > 0 ? tileFactors : halvings(width);
  const sizes = new Map<number, Size>();
  for (const factor of factors) {
    // Rounded to the nearest pixel, as servers list them: Cantaloupe lists a
    // 1335 pixel wide image’s halves as 668, where rounding down would give 667.
    const size = {
      width: Math.round(width / factor),
      height: Math.round(height / factor),
    };
    if (
      size.width >= MINIMUM_DERIVED_WIDTH &&
      size.height >= 1 &&
      isWithinLimits(size, document)
    ) {
      sizes.set(size.width, size);
    }
  }
  return [...sizes.values()];
}

function halvings(width: number): number[] {
  const factors = [];
  for (let factor = 1; width / factor >= MINIMUM_DERIVED_WIDTH; factor *= 2) {
    factors.push(factor);
  }
  return factors;
}

/**
 * Asking above a declared limit answers 404, not 400 (Image API 3.0 § 7.3), which
 * reads as a dead link. `maxWidth` alone also limits the height (§ 5.3).
 */
function isWithinLimits(
  size: { width: number; height: number },
  document: Record<string, unknown>,
): boolean {
  const { maxWidth, maxHeight, maxArea } = document;
  const heightLimit = isPositiveInteger(maxHeight) ? maxHeight : maxWidth;
  return (
    (!isPositiveInteger(maxWidth) || size.width <= maxWidth) &&
    (!isPositiveInteger(heightLimit) || size.height <= heightLimit) &&
    (!isPositiveInteger(maxArea) || size.width * size.height <= maxArea)
  );
}

/**
 * By `type` where it names a service, then by context, then by profile, because
 * an Image API 1.0 document may state no context and Image API 2 documents often
 * say `@type: iiif:Image`.
 */
function versionOf(
  document: Record<string, unknown>,
  profile: string,
): Version {
  const type = document.type ?? document['@type'];
  if (type === 'ImageService3') {
    return 3;
  }
  if (type === 'ImageService2') {
    return 2;
  }
  const context = JSON.stringify(document['@context'] ?? '');
  if (context.includes('image/3')) {
    return 3;
  }
  if (context.includes('image/2')) {
    return 2;
  }
  return /image-api|api\/image\/1/.test(`${context} ${profile}`) ? 1 : 2;
}

/** The compliance level, as `level2` in version 3 and as a URL before it. */
function levelOf(profile: string): Level {
  const level = /level([012])/.exec(profile)?.[1];
  return level === undefined ? undefined : (Number(level) as 0 | 1 | 2);
}

/** The compliance level, or `undefined` where the profile states none. */
type Level = 0 | 1 | 2 | undefined;

/** The profile naming the compliance level, which Image API 2 states first in an array. */
function profileOf(document: Record<string, unknown>): string {
  const profile = Array.isArray(document.profile)
    ? document.profile[0]
    : document.profile;
  return typeof profile === 'string' ? profile : '';
}

function isPositiveInteger(value: unknown): value is number {
  return Number.isInteger(value) && (value as number) > 0;
}
