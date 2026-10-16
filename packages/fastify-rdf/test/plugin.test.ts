import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fastify, { type FastifyInstance } from 'fastify';
import type { DatasetCore } from '@rdfjs/types';
import { DataFactory, Store, StreamParser } from 'n3';
import { Readable } from 'node:stream';
import { fastifyRdf } from '../src/index.js';

const { namedNode, literal, quad } = DataFactory;

const TEST_TURTLE = `
  <http://example.org/subject> <http://example.org/predicate> "object" .
`;

function createTestDataset(): Store {
  const store = new Store();
  store.add(
    quad(
      namedNode('http://example.org/subject'),
      namedNode('http://example.org/predicate'),
      literal('object'),
    ),
  );
  return store;
}

/**
 * Create a proper RDF.js Stream by parsing Turtle data.
 */
function createRdfStream() {
  const parser = new StreamParser();
  const textStream = Readable.from([TEST_TURTLE]);
  return textStream.pipe(parser);
}

describe('fastifyRdf plugin', () => {
  let app: FastifyInstance;

  beforeEach(async () => {
    app = fastify();
  });

  afterEach(async () => {
    await app.close();
  });

  describe('content negotiation', () => {
    it('should default to Turtle when no Accept header is provided', async () => {
      await app.register(fastifyRdf);
      app.get('/data', async (_request, reply) => {
        return reply.sendRdf(createTestDataset());
      });
      await app.ready();

      const response = await app.inject({
        method: 'GET',
        url: '/data',
      });

      expect(response.statusCode).toBe(200);
      expect(response.headers['content-type']).toContain('text/turtle');
    });

    it('should default to Turtle when Accept is */*', async () => {
      await app.register(fastifyRdf);
      app.get('/data', async (_request, reply) => {
        return reply.sendRdf(createTestDataset());
      });
      await app.ready();

      const response = await app.inject({
        method: 'GET',
        url: '/data',
        headers: { accept: '*/*' },
      });

      expect(response.statusCode).toBe(200);
      expect(response.headers['content-type']).toContain('text/turtle');
    });

    it('should serialize as Turtle when requested', async () => {
      await app.register(fastifyRdf);
      app.get('/data', async (_request, reply) => {
        return reply.sendRdf(createTestDataset());
      });
      await app.ready();

      const response = await app.inject({
        method: 'GET',
        url: '/data',
        headers: { accept: 'text/turtle' },
      });

      expect(response.statusCode).toBe(200);
      expect(response.headers['content-type']).toContain('text/turtle');
      expect(response.body).toContain('http://example.org/subject');
    });

    it('should serialize as N-Triples when requested', async () => {
      await app.register(fastifyRdf);
      app.get('/data', async (_request, reply) => {
        return reply.sendRdf(createTestDataset());
      });
      await app.ready();

      const response = await app.inject({
        method: 'GET',
        url: '/data',
        headers: { accept: 'application/n-triples' },
      });

      expect(response.statusCode).toBe(200);
      expect(response.headers['content-type']).toContain(
        'application/n-triples',
      );
      expect(response.body).toContain('<http://example.org/subject>');
    });

    it('should serialize as N-Quads when requested', async () => {
      await app.register(fastifyRdf);
      app.get('/data', async (_request, reply) => {
        return reply.sendRdf(createTestDataset());
      });
      await app.ready();

      const response = await app.inject({
        method: 'GET',
        url: '/data',
        headers: { accept: 'application/n-quads' },
      });

      expect(response.statusCode).toBe(200);
      expect(response.headers['content-type']).toContain('application/n-quads');
      expect(response.body).toContain('<http://example.org/subject>');
    });

    it('should not negotiate to SHACLC types', async () => {
      await app.register(fastifyRdf);
      app.get('/data', async (_request, reply) => {
        return reply.sendRdf(createTestDataset());
      });
      await app.ready();

      const response = await app.inject({
        method: 'GET',
        url: '/data',
        headers: { accept: 'text/shaclc, text/turtle;q=0.5' },
      });

      expect(response.statusCode).toBe(200);
      expect(response.headers['content-type']).toContain('text/turtle');
    });

    it('should fall back to default when Accept type is not supported', async () => {
      await app.register(fastifyRdf);
      app.get('/data', async (_request, reply) => {
        return reply.sendRdf(createTestDataset());
      });
      await app.ready();

      const response = await app.inject({
        method: 'GET',
        url: '/data',
        headers: { accept: 'application/unsupported-format' },
      });

      expect(response.statusCode).toBe(200);
      expect(response.headers['content-type']).toContain('text/turtle');
    });
  });

  describe('custom default content type', () => {
    it('should use custom default content type when configured', async () => {
      await app.register(fastifyRdf, {
        defaultContentType: 'text/turtle',
      });
      app.get('/data', async (_request, reply) => {
        return reply.sendRdf(createTestDataset());
      });
      await app.ready();

      const response = await app.inject({
        method: 'GET',
        url: '/data',
      });

      expect(response.statusCode).toBe(200);
      expect(response.headers['content-type']).toContain('text/turtle');
    });
  });

  describe('reply.sendRdf', () => {
    it('should serialize DatasetCore', async () => {
      await app.register(fastifyRdf);
      app.get('/data', async (_request, reply) => {
        return reply.sendRdf(createTestDataset());
      });
      await app.ready();

      const response = await app.inject({
        method: 'GET',
        url: '/data',
        headers: { accept: 'text/turtle' },
      });

      expect(response.statusCode).toBe(200);
      expect(response.headers['content-type']).toContain('text/turtle');
      expect(response.body).toContain('http://example.org/subject');
    });

    it('should serialize RDF.js Stream', async () => {
      await app.register(fastifyRdf);
      app.get('/data', async (_request, reply) => {
        return reply.sendRdf(createRdfStream());
      });
      await app.ready();

      const response = await app.inject({
        method: 'GET',
        url: '/data',
        headers: { accept: 'application/n-triples' },
      });

      expect(response.statusCode).toBe(200);
      expect(response.headers['content-type']).toContain(
        'application/n-triples',
      );
      expect(response.body).toContain('<http://example.org/subject>');
    });
  });

  describe('RDF body parsing', () => {
    it('should parse Turtle body into DatasetCore', async () => {
      await app.register(fastifyRdf);
      app.post('/data', { config: { parseRdf: true } }, async (request) => {
        const dataset = request.body as DatasetCore;
        return { size: dataset.size };
      });
      await app.ready();

      const response = await app.inject({
        method: 'POST',
        url: '/data',
        headers: { 'content-type': 'text/turtle' },
        body: '<http://example.org/s> <http://example.org/p> "o" .',
      });

      expect(response.statusCode).toBe(200);
      expect(response.json()).toEqual({ size: 1 });
    });

    it('should parse JSON-LD body into DatasetCore', async () => {
      await app.register(fastifyRdf);
      app.post('/data', { config: { parseRdf: true } }, async (request) => {
        const dataset = request.body as DatasetCore;
        return { size: dataset.size };
      });
      await app.ready();

      const response = await app.inject({
        method: 'POST',
        url: '/data',
        headers: { 'content-type': 'application/ld+json' },
        body: JSON.stringify({
          '@id': 'http://example.org/s',
          'http://example.org/p': 'o',
        }),
      });

      expect(response.statusCode).toBe(200);
      expect(response.json()).toEqual({ size: 1 });
    });

    it('should parse N-Triples body into DatasetCore', async () => {
      await app.register(fastifyRdf);
      app.post('/data', { config: { parseRdf: true } }, async (request) => {
        const dataset = request.body as DatasetCore;
        return { size: dataset.size };
      });
      await app.ready();

      const response = await app.inject({
        method: 'POST',
        url: '/data',
        headers: { 'content-type': 'application/n-triples' },
        body: '<http://example.org/s> <http://example.org/p> "o" .\n',
      });

      expect(response.statusCode).toBe(200);
      expect(response.json()).toEqual({ size: 1 });
    });

    it('should fall back to plain JSON for application/ld+json without parseRdf config', async () => {
      await app.register(fastifyRdf);
      app.post('/data', async (request) => {
        return { body: request.body };
      });
      await app.ready();

      const jsonLd = {
        '@id': 'http://example.org/s',
        'http://example.org/p': 'o',
      };
      const response = await app.inject({
        method: 'POST',
        url: '/data',
        headers: { 'content-type': 'application/ld+json' },
        body: JSON.stringify(jsonLd),
      });

      expect(response.statusCode).toBe(200);
      expect(response.json()).toEqual({ body: jsonLd });
    });

    it('should parse all routes when plugin-level parseRdf is set', async () => {
      await app.register(fastifyRdf, { parseRdf: true });
      app.post('/data', async (request) => {
        const dataset = request.body as DatasetCore;
        return { size: dataset.size };
      });
      await app.ready();

      const response = await app.inject({
        method: 'POST',
        url: '/data',
        headers: { 'content-type': 'text/turtle' },
        body: '<http://example.org/s> <http://example.org/p> "o" .',
      });

      expect(response.statusCode).toBe(200);
      expect(response.json()).toEqual({ size: 1 });
    });

    it('should return 415 for text/turtle without parseRdf config', async () => {
      await app.register(fastifyRdf);
      app.post('/data', async (request) => {
        return { body: request.body };
      });
      await app.ready();

      const response = await app.inject({
        method: 'POST',
        url: '/data',
        headers: { 'content-type': 'text/turtle' },
        body: '<http://example.org/s> <http://example.org/p> "o" .',
      });

      expect(response.statusCode).toBe(415);
    });

    it('should pass Fastify body schema validation for application/ld+json', async () => {
      await app.register(fastifyRdf);
      app.post(
        '/data',
        {
          config: { parseRdf: true },
          schema: {
            body: {
              type: 'object',
              required: ['@id'],
              properties: { '@id': { type: 'string' } },
            },
          },
        },
        async (request) => {
          // After preHandler, parseRdf converts the body to a DatasetCore.
          const dataset = request.body as DatasetCore;
          return { size: dataset.size };
        },
      );
      await app.ready();

      const response = await app.inject({
        method: 'POST',
        url: '/data',
        headers: { 'content-type': 'application/ld+json' },
        body: JSON.stringify({
          '@id': 'http://example.org/s',
          'http://example.org/p': 'o',
        }),
      });

      expect(response.statusCode).toBe(200);
      expect(response.json()).toEqual({ size: 1 });
    });

    it('should reject application/ld+json that fails body schema validation', async () => {
      await app.register(fastifyRdf);
      app.post(
        '/data',
        {
          config: { parseRdf: true },
          schema: {
            body: {
              type: 'object',
              required: ['@id'],
              properties: { '@id': { type: 'string' } },
            },
          },
        },
        async (request) => {
          const dataset = request.body as DatasetCore;
          return { size: dataset.size };
        },
      );
      await app.ready();

      const response = await app.inject({
        method: 'POST',
        url: '/data',
        headers: { 'content-type': 'application/ld+json' },
        body: JSON.stringify({ 'http://example.org/p': 'o' }),
      });

      expect(response.statusCode).toBe(400);
    });

    it('should return 400 for malformed JSON-LD body', async () => {
      await app.register(fastifyRdf);
      app.post('/data', { config: { parseRdf: true } }, async (request) => {
        const dataset = request.body as DatasetCore;
        return { size: dataset.size };
      });
      await app.ready();

      const response = await app.inject({
        method: 'POST',
        url: '/data',
        headers: { 'content-type': 'application/ld+json' },
        body: 'this is not valid json {{{',
      });

      expect(response.statusCode).toBe(400);
    });

    it('should load remote JSON-LD contexts through the fetch option', async () => {
      const contextUrl = 'http://example.org/context.jsonld';
      const fetchedUrls: string[] = [];
      const stubFetch: typeof globalThis.fetch = async (input) => {
        fetchedUrls.push(String(input));
        return new Response(
          JSON.stringify({
            '@context': {
              license: { '@id': 'http://example.org/license', '@type': '@id' },
            },
          }),
          { headers: { 'content-type': 'application/ld+json' } },
        );
      };
      await app.register(fastifyRdf, { fetch: stubFetch });
      app.post('/data', { config: { parseRdf: true } }, async (request) => {
        const dataset = request.body as DatasetCore;
        return [...dataset].map((quad) => quad.object.termType);
      });
      await app.ready();

      const response = await app.inject({
        method: 'POST',
        url: '/data',
        headers: { 'content-type': 'application/ld+json' },
        body: JSON.stringify({
          '@context': contextUrl,
          '@id': 'http://example.org/dataset',
          license: 'https://creativecommons.org/licenses/by/4.0/',
        }),
      });

      expect(response.statusCode).toBe(200);
      expect(fetchedUrls).toEqual([contextUrl]);
      expect(response.json()).toEqual(['NamedNode']);
    });

    it('should return 400 for malformed RDF body', async () => {
      await app.register(fastifyRdf);
      app.post('/data', { config: { parseRdf: true } }, async (request) => {
        const dataset = request.body as DatasetCore;
        return { size: dataset.size };
      });
      await app.ready();

      const response = await app.inject({
        method: 'POST',
        url: '/data',
        headers: { 'content-type': 'text/turtle' },
        body: 'this is not valid turtle {{{',
      });

      expect(response.statusCode).toBe(400);
    });
  });

  describe('reply.sendHydraError', () => {
    it('should return compact JSON-LD Hydra error for Accept: application/ld+json', async () => {
      await app.register(fastifyRdf);
      app.get('/error', async (_request, reply) => {
        const error = new Error('Not Found') as Error & { statusCode: number };
        error.statusCode = 404;
        return reply.sendHydraError(error);
      });
      await app.ready();

      const response = await app.inject({
        method: 'GET',
        url: '/error',
        headers: { accept: 'application/ld+json' },
      });

      expect(response.statusCode).toBe(404);
      expect(response.headers['content-type']).toContain('application/ld+json');
      const json = response.json();
      expect(json['@context']).toBe('http://www.w3.org/ns/hydra/core#');
      expect(json['@type']).toBe('Error');
      expect(json['title']).toBe('Not Found');
    });

    it('should include description from string error.cause', async () => {
      await app.register(fastifyRdf);
      app.get('/error', async (_request, reply) => {
        const error = new Error('Not Found', {
          cause: 'The dataset was not found',
        }) as Error & { statusCode: number };
        error.statusCode = 404;
        return reply.sendHydraError(error);
      });
      await app.ready();

      const response = await app.inject({
        method: 'GET',
        url: '/error',
        headers: { accept: 'application/ld+json' },
      });

      const json = response.json();
      expect(json['description']).toBe('The dataset was not found');
    });

    it('should omit description when cause is not a string', async () => {
      await app.register(fastifyRdf);
      app.get('/error', async (_request, reply) => {
        const error = new Error('Internal error', {
          cause: new Error('underlying'),
        }) as Error & { statusCode: number };
        error.statusCode = 500;
        return reply.sendHydraError(error);
      });
      await app.ready();

      const response = await app.inject({
        method: 'GET',
        url: '/error',
        headers: { accept: 'application/ld+json' },
      });

      const json = response.json();
      expect(json).not.toHaveProperty('description');
    });

    it('should default to status 500 when statusCode is absent', async () => {
      await app.register(fastifyRdf);
      app.get('/error', async (_request, reply) => {
        return reply.sendHydraError(new Error('Something broke'));
      });
      await app.ready();

      const response = await app.inject({
        method: 'GET',
        url: '/error',
        headers: { accept: 'application/ld+json' },
      });

      expect(response.statusCode).toBe(500);
    });

    it('should serialise as Turtle for Accept: text/turtle', async () => {
      await app.register(fastifyRdf);
      app.get('/error', async (_request, reply) => {
        const error = new Error('Not Found') as Error & { statusCode: number };
        error.statusCode = 404;
        return reply.sendHydraError(error);
      });
      await app.ready();

      const response = await app.inject({
        method: 'GET',
        url: '/error',
        headers: { accept: 'text/turtle' },
      });

      expect(response.statusCode).toBe(404);
      expect(response.headers['content-type']).toContain('text/turtle');
      expect(response.body).toContain('http://www.w3.org/ns/hydra/core#Error');
      expect(response.body).toContain('Not Found');
    });

    it('should serialise as N-Triples for Accept: application/n-triples', async () => {
      await app.register(fastifyRdf);
      app.get('/error', async (_request, reply) => {
        const error = new Error('Not Found') as Error & { statusCode: number };
        error.statusCode = 404;
        return reply.sendHydraError(error);
      });
      await app.ready();

      const response = await app.inject({
        method: 'GET',
        url: '/error',
        headers: { accept: 'application/n-triples' },
      });

      expect(response.statusCode).toBe(404);
      expect(response.headers['content-type']).toContain(
        'application/n-triples',
      );
      expect(response.body).toContain(
        '<http://www.w3.org/ns/hydra/core#Error>',
      );
    });

    it('should work correctly under overrideSend mode', async () => {
      await app.register(fastifyRdf, { overrideSend: true });
      app.get('/error', async (_request, reply) => {
        const error = new Error('Not Found') as Error & { statusCode: number };
        error.statusCode = 404;
        return reply.sendHydraError(error);
      });
      await app.ready();

      const response = await app.inject({
        method: 'GET',
        url: '/error',
        headers: { accept: 'application/ld+json' },
      });

      expect(response.statusCode).toBe(404);
      const json = response.json();
      expect(json['@type']).toBe('Error');
      expect(json['title']).toBe('Not Found');
    });

    it('should use default content type when no Accept header', async () => {
      await app.register(fastifyRdf);
      app.get('/error', async (_request, reply) => {
        const error = new Error('Not Found') as Error & { statusCode: number };
        error.statusCode = 404;
        return reply.sendHydraError(error);
      });
      await app.ready();

      const response = await app.inject({
        method: 'GET',
        url: '/error',
      });

      expect(response.statusCode).toBe(404);
      expect(response.headers['content-type']).toContain('text/turtle');
      expect(response.body).toContain('Not Found');
    });
  });

  describe('overrideSend option', () => {
    it('should serialize DatasetCore returned from handler', async () => {
      await app.register(fastifyRdf, { overrideSend: true });
      app.get('/data', async () => {
        return createTestDataset();
      });
      await app.ready();

      const response = await app.inject({
        method: 'GET',
        url: '/data',
        headers: { accept: 'text/turtle' },
      });

      expect(response.statusCode).toBe(200);
      expect(response.headers['content-type']).toContain('text/turtle');
      expect(response.body).toContain('http://example.org/subject');
    });

    it('should serialize RDF.js Stream returned from handler', async () => {
      await app.register(fastifyRdf, { overrideSend: true });
      app.get('/data', async () => {
        return createRdfStream();
      });
      await app.ready();

      const response = await app.inject({
        method: 'GET',
        url: '/data',
        headers: { accept: 'application/n-triples' },
      });

      expect(response.statusCode).toBe(200);
      expect(response.headers['content-type']).toContain(
        'application/n-triples',
      );
      expect(response.body).toContain('<http://example.org/subject>');
    });

    it('should use default content type when no Accept header', async () => {
      await app.register(fastifyRdf, { overrideSend: true });
      app.get('/data', async () => {
        return createTestDataset();
      });
      await app.ready();

      const response = await app.inject({
        method: 'GET',
        url: '/data',
      });

      expect(response.statusCode).toBe(200);
      expect(response.headers['content-type']).toContain('text/turtle');
    });
  });
});
