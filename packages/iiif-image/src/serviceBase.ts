/**
 * The base URL image requests extend: an image service stated with a trailing
 * slash, or as its `info.json`, without either.
 */
export function serviceBase(url: string): string {
  return url.replace(/\/info\.json$/, '').replace(/\/+$/, '');
}
