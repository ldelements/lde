import type { DatasetCore, Stream } from '@rdfjs/types';

/**
 * Default content type when no Accept header is provided.
 */
export const DEFAULT_CONTENT_TYPE = 'text/turtle';

/**
 * Options for the fastify-rdf plugin.
 */
export interface FastifyRdfOptions {
  /**
   * Default content type when no Accept header is provided.
   * @default 'text/turtle'
   */
  defaultContentType?: string;

  /**
   * Override reply.send() to serialize all responses as RDF.
   * When enabled, all payloads returned from route handlers will be
   * serialized as RDF.
   * @default false
   */
  overrideSend?: boolean;

  /**
   * Parse RDF request bodies into a DatasetCore on all routes.
   * When not set, individual routes can opt in via `config: { parseRdf: true }`.
   * @default false
   */
  parseRdf?: boolean;

  /**
   * Fetch used to load remote documents, such as JSON-LD contexts, while
   * parsing RDF request bodies. Pass one to answer context requests from a
   * local copy or cache instead of the network.
   * @default globalThis.fetch
   */
  fetch?: typeof globalThis.fetch;
}

/**
 * RDF data that can be serialized: either a DatasetCore or an RDF.js Stream of quads.
 */
export type RdfData = DatasetCore | Stream;

declare module 'fastify' {
  interface FastifyReply {
    /**
     * Send RDF data with content negotiation based on Accept header.
     * @param data - RDF DatasetCore or Stream to serialize
     * @returns The data (when overrideSend is enabled) or Promise<FastifyReply>
     */
    sendRdf(data: RdfData): RdfData | Promise<FastifyReply>;

    /**
     * Send a Hydra error response with content negotiation.
     * Uses `error.message` as `hydra:title` and `error.cause` (if a string) as `hydra:description`.
     * Status code defaults to `error.statusCode` or 500.
     */
    sendHydraError(
      error: Error & { statusCode?: number },
    ): Promise<FastifyReply>;
  }

  interface FastifyContextConfig {
    parseRdf?: boolean;
  }
}
