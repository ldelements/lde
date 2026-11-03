import { describe, expect, it, vi } from 'vitest';
import {
  fetchPublic,
  RefusedUrlError,
  ResponseTooLargeError,
} from '../src/index.js';

function answering(answers: Record<string, Response>) {
  return vi.fn(async (input: string | URL | Request) => {
    const answer = answers[String(input)];
    if (answer === undefined) {
      throw new Error(`unexpected request for ${String(input)}`);
    }
    return answer;
  });
}

function redirect(location: string, status = 302) {
  return new Response(null, { status, headers: { location } });
}

describe('fetchPublic', () => {
  it.each([
    'https://example.org/iiif/manifest.json',
    'http://example.org/iiif/manifest.json',
    'https://n2t.net/ark:/50282/CBB6/iiif.json',
    'https://images.example.org/i/?IIIF=/7b/image.tif',
    'https://8.8.8.8/manifest',
    'https://[2606:4700:4700::1111]/manifest',
  ])('fetches %s', async (url) => {
    const fetch = answering({ [url]: Response.json({}) });

    await fetchPublic(url, { fetch });

    expect(fetch).toHaveBeenCalledOnce();
  });

  it.each([
    'file:///etc/passwd',
    'ftp://example.org/manifest',
    'not a url',
    'http://127.0.0.1/manifest',
    'http://2130706433/manifest',
    'http://10.0.0.5/manifest',
    'http://172.16.0.1/manifest',
    'http://192.168.1.1/manifest',
    'http://169.254.169.254/latest/meta-data',
    'http://100.64.0.1/manifest',
    'http://[::1]/manifest',
    'http://[::ffff:127.0.0.1]/manifest',
    'http://[fe80::1]/manifest',
    'http://[fd00::1]/manifest',
    'http://[::7f00:1]/manifest',
    'http://[64:ff9b::a9fe:a9fe]/latest',
    'http://[2002:7f00:1::]/manifest',
    'http://[ff02::1]/manifest',
    'http://224.0.0.1/manifest',
    'http://255.255.255.255/manifest',
    'http://198.18.0.1/manifest',
    'http://192.0.0.8/manifest',
    'http://localhost/manifest',
    'http://localhost./manifest',
    'http://typesense:8108/collections',
    'http://search-api.default.svc/graphql',
    'http://kubernetes.default.svc./api',
    'http://search-api.default.svc.cluster.local/graphql',
    'http://metadata.google.internal./computeMetadata',
  ])('refuses %s without fetching it', async (url) => {
    const fetch = answering({});

    await expect(fetchPublic(url, { fetch })).rejects.toBeInstanceOf(
      RefusedUrlError,
    );
    expect(fetch).not.toHaveBeenCalled();
  });

  it('fetches a public URL', async () => {
    const fetch = answering({
      'https://example.org/a': Response.json({ ok: true }),
    });

    const response = await fetchPublic('https://example.org/a', { fetch });

    expect(await response.json()).toEqual({ ok: true });
  });

  it('refuses an internal URL without fetching it', async () => {
    const fetch = answering({});

    await expect(
      fetchPublic('http://169.254.169.254/latest', { fetch }),
    ).rejects.toBeInstanceOf(RefusedUrlError);
    expect(fetch).not.toHaveBeenCalled();
  });

  it('follows public redirects, resolving relative locations', async () => {
    const fetch = answering({
      'https://n2t.net/ark:/1/x': redirect('https://example.org/ark:/1/x', 301),
      'https://example.org/ark:/1/x': redirect('/manifests/x.json', 307),
      'https://example.org/manifests/x.json': Response.json({ id: 'x' }),
    });

    const response = await fetchPublic('https://n2t.net/ark:/1/x', { fetch });

    expect(await response.json()).toEqual({ id: 'x' });
    expect(fetch).toHaveBeenCalledTimes(3);
  });

  it('refuses a redirect to an internal URL without following it', async () => {
    const fetch = answering({
      'https://example.org/a': redirect('http://10.0.0.5/secret'),
    });

    await expect(
      fetchPublic('https://example.org/a', { fetch }),
    ).rejects.toThrow('http://10.0.0.5/secret is not a public web address');
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it('gives up after ten redirects', async () => {
    // A fresh redirect on every call, back and forth between two URLs.
    const fetch = vi.fn(async (input: string | URL | Request) =>
      redirect(
        String(input).endsWith('/a')
          ? 'https://example.org/b'
          : 'https://example.org/a',
      ),
    );

    await expect(
      fetchPublic('https://example.org/a', { fetch }),
    ).rejects.toThrow('redirected more than 10 times');
    expect(fetch).toHaveBeenCalledTimes(11);
  });

  it('drops credentials on a cross-origin redirect, and keeps them on the same origin', async () => {
    const fetch = answering({
      'https://example.org/a': redirect('https://example.org/b'),
      'https://example.org/b': redirect('https://elsewhere.example/c'),
      'https://elsewhere.example/c': Response.json({}),
    });

    await fetchPublic('https://example.org/a', {
      fetch,
      headers: { Authorization: 'Bearer secret', Accept: '*/*' },
    });

    const sent = (fetch.mock.calls as unknown as [string, RequestInit][]).map(
      ([, init]) => new Headers(init.headers),
    );
    expect(sent.map((headers) => headers.get('authorization'))).toEqual([
      'Bearer secret',
      'Bearer secret',
      null,
    ]);
    expect(sent[2].get('accept')).toBe('*/*');
  });

  it('returns a redirect with a malformed location as it is', async () => {
    const fetch = answering({
      'https://example.org/a': redirect('http://[bad'),
    });

    const response = await fetchPublic('https://example.org/a', { fetch });

    expect(response.status).toBe(302);
  });

  it('returns a redirect status without a location as it is', async () => {
    const fetch = answering({
      'https://example.org/a': new Response(null, { status: 302 }),
    });

    const response = await fetchPublic('https://example.org/a', { fetch });

    expect(response.status).toBe(302);
  });

  it('passes headers and signal on every hop, and handles redirects itself', async () => {
    const fetch = answering({
      'https://example.org/a': redirect('https://example.org/b'),
      'https://example.org/b': Response.json({}),
    });
    const signal = new AbortController().signal;

    await fetchPublic('https://example.org/a', {
      fetch,
      signal,
      headers: { Accept: '*/*' },
    });

    for (const [, init] of fetch.mock.calls as unknown as [
      string,
      RequestInit,
    ][]) {
      expect(init).toEqual({
        signal,
        headers: { Accept: '*/*' },
        redirect: 'manual',
      });
    }
  });

  it('uses the global fetch by default', async () => {
    const fetch = answering({ 'https://example.org/a': Response.json({}) });
    vi.stubGlobal('fetch', fetch);
    try {
      await fetchPublic('https://example.org/a');
    } finally {
      vi.unstubAllGlobals();
    }

    expect(fetch).toHaveBeenCalledOnce();
  });
});

describe('the response body', () => {
  function served(response: Response) {
    return fetchPublic('https://example.org/a', {
      fetch: answering({ 'https://example.org/a': response }),
    });
  }

  it('reads as JSON within the limit, with status and headers kept', async () => {
    const response = await served(
      Response.json({ width: 1335 }, { status: 201 }),
    );

    expect(response.status).toBe(201);
    expect(response.headers.get('content-type')).toBe('application/json');
    expect(await response.json()).toEqual({ width: 1335 });
  });

  it('reports the URL it was finally served from', async () => {
    const response = await fetchPublic('https://example.org/a', {
      fetch: answering({
        'https://example.org/a': redirect('https://example.org/b'),
        'https://example.org/b': Response.json({}),
      }),
    });

    expect(response.url).toBe('https://example.org/b');
    expect(response.redirected).toBe(true);
  });

  it('fails when it declares a length above 20 MiB, without reading it', async () => {
    const response = await served(
      new Response('{}', {
        headers: { 'content-length': String(21 * 1024 * 1024) },
      }),
    );

    await expect(response.json()).rejects.toBeInstanceOf(ResponseTooLargeError);
  });

  it('stops reading when it grows past 20 MiB', async () => {
    const chunk = new Uint8Array(1024 * 1024);
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        controller.enqueue(chunk);
      },
    });
    const response = await served(new Response(body));

    await expect(response.text()).rejects.toBeInstanceOf(ResponseTooLargeError);
  });

  it('cannot come with a status outside 200–599, which a Response cannot carry', async () => {
    const odd = new Response(null);
    Object.defineProperty(odd, 'status', { value: 999 });

    await expect(served(odd)).rejects.toThrow(
      'https://example.org/a answered with status 999',
    );
  });

  it('is not read until the caller reads it', async () => {
    const pull = vi.fn();
    await served(
      new Response(new ReadableStream({ pull }, { highWaterMark: 0 })),
    );

    expect(pull).not.toHaveBeenCalled();
  });

  it('can be cancelled unread', async () => {
    const response = await served(Response.json({}));

    await expect(response.body?.cancel()).resolves.toBeUndefined();
  });

  it('parses JSON that starts with a byte order mark', async () => {
    const response = await served(new Response('\uFEFF{"width":1}'));

    expect(await response.json()).toEqual({ width: 1 });
  });

  it('is absent where the server sent none', async () => {
    const response = await served(new Response(null, { status: 204 }));

    expect(response.body).toBeNull();
  });
});
