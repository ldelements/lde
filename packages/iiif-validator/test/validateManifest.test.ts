import { validateManifest } from '../src/index.js';
import { describe, it, expect } from 'vitest';

/**
 * Build a fake `fetch` that always resolves with the given body and status.
 */
function fetchReturning(
  body: string,
  init?: { status?: number; contentType?: string },
): typeof globalThis.fetch {
  return (async () =>
    new Response(body, {
      status: init?.status ?? 200,
      headers: { 'Content-Type': init?.contentType ?? 'application/ld+json' },
    })) as typeof globalThis.fetch;
}

const URL = 'https://example.org/manifest.json';

describe('validateManifest', () => {
  it('accepts a IIIF Presentation v3 Manifest', async () => {
    const fetch = fetchReturning(
      JSON.stringify({
        '@context': 'http://iiif.io/api/presentation/3/context.json',
        id: URL,
        type: 'Manifest',
      }),
    );

    const verdict = await validateManifest(URL, { fetch });

    expect(verdict).toEqual({ valid: true, reason: 'valid-manifest' });
  });

  it('accepts a IIIF Presentation v2 Manifest (sc:Manifest)', async () => {
    const fetch = fetchReturning(
      JSON.stringify({
        '@context': 'http://iiif.io/api/presentation/2/context.json',
        '@id': URL,
        '@type': 'sc:Manifest',
      }),
    );

    const verdict = await validateManifest(URL, { fetch });

    expect(verdict).toEqual({ valid: true, reason: 'valid-manifest' });
  });

  it('accepts an @context array that includes the IIIF Presentation context', async () => {
    const fetch = fetchReturning(
      JSON.stringify({
        '@context': [
          'http://www.w3.org/ns/anno.jsonld',
          'http://iiif.io/api/presentation/3/context.json',
        ],
        id: URL,
        type: 'Manifest',
      }),
    );

    const verdict = await validateManifest(URL, { fetch });

    expect(verdict).toEqual({ valid: true, reason: 'valid-manifest' });
  });

  it('accepts an @context object that references the IIIF Presentation context', async () => {
    const fetch = fetchReturning(
      JSON.stringify({
        '@context': {
          '@import': 'http://iiif.io/api/presentation/3/context.json',
        },
        id: URL,
        type: 'Manifest',
      }),
    );

    const verdict = await validateManifest(URL, { fetch });

    expect(verdict).toEqual({ valid: true, reason: 'valid-manifest' });
  });

  it('reports http-error for a non-2xx response', async () => {
    const fetch = fetchReturning('Not Found', { status: 404 });

    const verdict = await validateManifest(URL, { fetch });

    expect(verdict).toEqual({ valid: false, reason: 'http-error' });
  });

  it('reports invalid-json for an unparseable body', async () => {
    const fetch = fetchReturning('<html>not json</html>');

    const verdict = await validateManifest(URL, { fetch });

    expect(verdict).toEqual({ valid: false, reason: 'invalid-json' });
  });

  it('reports not-a-manifest for a non-Manifest type (e.g. a Collection)', async () => {
    const fetch = fetchReturning(
      JSON.stringify({
        '@context': 'http://iiif.io/api/presentation/3/context.json',
        id: URL,
        type: 'Collection',
      }),
    );

    const verdict = await validateManifest(URL, { fetch });

    expect(verdict).toEqual({ valid: false, reason: 'not-a-manifest' });
  });

  it('reports not-a-manifest when the IIIF Presentation @context is absent', async () => {
    const fetch = fetchReturning(
      JSON.stringify({
        '@context': 'http://schema.org/',
        id: URL,
        type: 'Manifest',
      }),
    );

    const verdict = await validateManifest(URL, { fetch });

    expect(verdict).toEqual({ valid: false, reason: 'not-a-manifest' });
  });

  it('reports binary-content without reading the body when the server announces an image', async () => {
    // The body’s `json()` throws, so reaching it would surface as invalid-json;
    // getting binary-content proves the content-type gate short-circuited before
    // the body was buffered. `body.cancel()` frees the connection.
    let bodyCancelled = false;
    const fetch = (async () =>
      ({
        ok: true,
        headers: new Headers({ 'Content-Type': 'image/jpeg' }),
        body: {
          cancel: async () => {
            bodyCancelled = true;
          },
        },
        json: async () => {
          throw new Error('the body must not be read for binary media');
        },
      }) as unknown as Response) as typeof globalThis.fetch;

    const verdict = await validateManifest(URL, { fetch });

    expect(verdict).toEqual({ valid: false, reason: 'binary-content' });
    expect(bodyCancelled).toBe(true);
  });

  it('reports binary-content for audio and video too, case-insensitively', async () => {
    for (const contentType of ['audio/mpeg', 'video/mp4', 'IMAGE/PNG']) {
      const fetch = fetchReturning('binary', { contentType });
      const verdict = await validateManifest(URL, { fetch });
      expect(verdict).toEqual({ valid: false, reason: 'binary-content' });
    }
  });

  it('still parses a manifest served with an ambiguous content type', async () => {
    const fetch = fetchReturning(
      JSON.stringify({
        '@context': 'http://iiif.io/api/presentation/3/context.json',
        id: URL,
        type: 'Manifest',
      }),
      { contentType: 'application/octet-stream' },
    );

    const verdict = await validateManifest(URL, { fetch });

    expect(verdict).toEqual({ valid: true, reason: 'valid-manifest' });
  });

  it('parses the manifest when the server sends no content type', async () => {
    const fetch = (async () =>
      ({
        ok: true,
        headers: new Headers(),
        json: async () => ({
          '@context': 'http://iiif.io/api/presentation/3/context.json',
          id: URL,
          type: 'Manifest',
        }),
      }) as unknown as Response) as typeof globalThis.fetch;

    const verdict = await validateManifest(URL, { fetch });

    expect(verdict).toEqual({ valid: true, reason: 'valid-manifest' });
  });

  it('reports timeout when the request aborts', async () => {
    const fetch = (async () => {
      throw new DOMException('The operation timed out.', 'TimeoutError');
    }) as typeof globalThis.fetch;

    const verdict = await validateManifest(URL, { fetch });

    expect(verdict).toEqual({ valid: false, reason: 'timeout' });
  });

  it('reports network-error when the request fails to connect', async () => {
    const fetch = (async () => {
      throw new TypeError('fetch failed');
    }) as typeof globalThis.fetch;

    const verdict = await validateManifest(URL, { fetch });

    expect(verdict).toEqual({ valid: false, reason: 'network-error' });
  });
});
