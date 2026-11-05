import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { DatasetCore, Stream, Quad } from '@rdfjs/types';
import { fastifyPlugin } from 'fastify-plugin';
import { fastifyAccepts } from '@fastify/accepts';
import { rdfSerializer } from 'rdf-serialize';
import { rdfParser } from 'rdf-parse';
import { FetchDocumentLoader } from 'jsonld-context-parser';
import { Store } from 'n3';
import { Readable } from 'node:stream';
import {
  DEFAULT_CONTENT_TYPE,
  type FastifyRdfOptions,
  type RdfData,
} from './types.js';
import {
  serializeHydraErrorAsJsonLd,
  createHydraErrorDataset,
} from './hydra-error.js';

/**
 * Collect a readable stream into a string.
 */
async function streamToString(stream: NodeJS.ReadableStream): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as string));
  }
  return Buffer.concat(chunks).toString('utf8');
}

/**
 * Serialize RDF data to a string for the given content type.
 */
async function serializeRdfToString(
  data: RdfData,
  contentType: string,
): Promise<string> {
  const stream =
    typeof (data as DatasetCore)[Symbol.iterator] === 'function'
      ? Readable.from(data as DatasetCore)
      : data;
  const outputStream = rdfSerializer.serialize(stream as Stream<Quad>, {
    contentType,
  });
  return streamToString(outputStream);
}

/**
 * Find the best matching content type from supported types based on Accept header.
 */
function negotiateContentType(
  request: FastifyRequest,
  supportedTypes: string[],
  defaultType: string,
): string {
  const acceptHeader = request.headers.accept;
  if (!acceptHeader || acceptHeader === '*/*') {
    return defaultType;
  }
  return (
    (request.accepts().type(supportedTypes) as string | false) || defaultType
  );
}

/**
 * Collect quads from a readable stream into an N3 Store.
 */
async function streamToDataset(
  stream: NodeJS.ReadableStream,
): Promise<DatasetCore> {
  const store = new Store();
  for await (const quad of stream as AsyncIterable<Quad>) {
    store.add(quad);
  }
  return store;
}

/**
 * Register Fastify content type parsers for all RDF formats.
 *
 * When `parseAll` is true (from the plugin-level `parseRdf` option), every
 * route gets RDF body parsing. Otherwise, routes opt in individually via
 * `config: { parseRdf: true }`. Non-opted-in routes get JSON fallback for
 * `application/ld+json` and 415 for other RDF types.
 */
async function registerRdfParsers(
  server: FastifyInstance,
  parseAll: boolean,
  fetch: typeof globalThis.fetch | undefined,
): Promise<void> {
  const contentTypes = (await rdfParser.getContentTypes()).filter(
    (type) => type !== 'application/json',
  );
  // rdf-parse only routes JSON-LD context requests through a document loader
  // set under this Comunica context key; a plain `fetch` option is ignored.
  const parseContext = fetch
    ? {
        '@comunica/actor-rdf-parse-jsonld:documentLoader':
          new FetchDocumentLoader(fetch),
      }
    : {};

  const jsonLdType = 'application/ld+json';

  // JSON-LD is JSON.parse'd eagerly so the body is a plain object when
  // Fastify runs preValidation (schema checks happen before preHandler).
  // Other RDF types are stored as a raw Buffer for the preHandler hook.
  server.addContentTypeParser(contentTypes, function (request, payload, done) {
    const isJsonLd =
      request.headers['content-type']?.split(';')[0].trim() === jsonLdType;
    const chunks: Buffer[] = [];
    payload.on('data', (chunk: Buffer) => chunks.push(chunk));
    payload.on('end', () => {
      if (!isJsonLd) return done(null, Buffer.concat(chunks));
      try {
        done(null, JSON.parse(Buffer.concat(chunks).toString('utf8')));
      } catch (err) {
        (err as Error & { statusCode?: number }).statusCode = 400;
        done(err as Error);
      }
    });
    payload.on('error', done);
  });

  server.addHook('preHandler', async (request) => {
    if (!request.body || !request.headers['content-type']) return;
    const contentType = request.headers['content-type'].split(';')[0].trim();
    if (!contentTypes.includes(contentType)) return;

    if (!(parseAll || request.routeOptions.config.parseRdf)) {
      // Not a parseRdf route: JSON-LD is already parsed; reject other RDF.
      if (contentType !== jsonLdType) {
        const error = new Error(
          `Unsupported Media Type: ${contentType}`,
        ) as Error & { statusCode: number };
        error.statusCode = 415;
        throw error;
      }
      return;
    }

    try {
      // JSON-LD body is already an object; re-stringify for rdf-parse.
      const raw = Buffer.isBuffer(request.body)
        ? request.body
        : Buffer.from(JSON.stringify(request.body));
      request.body = await streamToDataset(
        rdfParser.parse(Readable.from(raw), { ...parseContext, contentType }),
      );
    } catch (cause) {
      const error = new Error('Invalid RDF body', {
        cause,
      }) as Error & { statusCode: number };
      error.statusCode = 400;
      throw error;
    }
  });
}

/**
 * Fastify plugin for serving RDF data with content negotiation.
 *
 * This plugin:
 * - Adds a reply.sendRdf() decorator for sending RDF data
 * - Optionally overrides reply.send() to serialize all responses as RDF
 * - Handles content negotiation via Accept headers
 * - Defaults to Turtle when no Accept header is provided
 * - Registers content type parsers for RDF request bodies
 */
async function fastifyRdfPlugin(
  server: FastifyInstance,
  options: FastifyRdfOptions,
): Promise<void> {
  const defaultContentType = options.defaultContentType ?? DEFAULT_CONTENT_TYPE;
  // Exclude SHACLC types: they require a base IRI that we can't provide generically,
  // and they cause "Base expected" errors during serialization.
  const supportedContentTypes = (await rdfSerializer.getContentTypes()).filter(
    (type) => !type.startsWith('text/shaclc'),
  );

  await server.register(fastifyAccepts);

  if (options.overrideSend) {
    // Serialize all responses as RDF via hooks
    server.addHook('preSerialization', async (request, reply, payload) => {
      const contentType = negotiateContentType(
        request,
        supportedContentTypes,
        defaultContentType,
      );
      reply.type(contentType);
      return serializeRdfToString(payload as RdfData, contentType);
    });

    server.addHook('onSend', async (request, reply, payload) => {
      // Handle streams (preSerialization doesn't run for streams)
      if (payload !== null && typeof payload !== 'string') {
        const contentType = negotiateContentType(
          request,
          supportedContentTypes,
          defaultContentType,
        );
        reply.type(contentType);
        return serializeRdfToString(payload as RdfData, contentType);
      }
      return payload;
    });

    // sendRdf just returns data - hooks handle serialization
    server.decorateReply(
      'sendRdf',
      function (this: FastifyReply, data: RdfData): RdfData {
        return data;
      },
    );
  } else {
    // Manual serialization via sendRdf() only
    server.decorateReply(
      'sendRdf',
      async function (
        this: FastifyReply,
        data: RdfData,
      ): Promise<FastifyReply> {
        const contentType = negotiateContentType(
          this.request,
          supportedContentTypes,
          defaultContentType,
        );
        this.type(contentType);
        const serialized = await serializeRdfToString(data, contentType);
        return this.send(serialized);
      },
    );
  }

  server.decorateReply(
    'sendHydraError',
    async function (
      this: FastifyReply,
      error: Error & { statusCode?: number },
    ): Promise<FastifyReply> {
      this.status(error.statusCode ?? 500);
      const title = error.message;
      const description =
        typeof error.cause === 'string' ? error.cause : undefined;
      const contentType = negotiateContentType(
        this.request,
        supportedContentTypes,
        defaultContentType,
      );
      if (contentType === 'application/ld+json') {
        this.type('application/ld+json');
        return this.send(serializeHydraErrorAsJsonLd(title, description));
      }
      const dataset = createHydraErrorDataset(title, description);
      this.type(contentType);
      return this.send(await serializeRdfToString(dataset, contentType));
    },
  );

  await registerRdfParsers(server, options.parseRdf ?? false, options.fetch);
}

/**
 * Fastify plugin for serving RDF data with content negotiation.
 */
export const fastifyRdf = fastifyPlugin(fastifyRdfPlugin, {
  fastify: '5.x',
  name: '@lde/fastify-rdf',
});
