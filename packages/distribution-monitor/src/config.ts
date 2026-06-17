import { Distribution } from '@lde/dataset';
import type { MonitorConfig } from './types.js';

/**
 * Shape of a single monitor entry in a configuration file. URLs may be
 * supplied as strings for YAML/JSON ergonomics; they are converted to
 * {@link URL} objects by {@link normalizeConfig}.
 */
export interface RawMonitorConfig {
  /** Unique identifier for this monitor. */
  identifier: string;
  /** The distribution to probe. */
  distribution: {
    /** Distribution access URL. */
    accessUrl: string | URL;
    /**
     * Plain content-type (e.g. `application/n-triples`) or DCAT-AP 3.0
     * IANA media type URI.
     */
    mediaType?: string;
    /**
     * Specification the distribution conforms to, e.g.
     * `https://www.w3.org/TR/sparql11-protocol/` for SPARQL endpoints.
     */
    conformsTo?: string | URL;
  };
  /**
   * SPARQL query to run against SPARQL-endpoint distributions. Ignored for
   * data-dump distributions.
   */
  sparqlQuery?: string;
}

/**
 * Configuration for the distribution monitor.
 */
export interface DistributionMonitorConfig {
  /** PostgreSQL connection string. */
  databaseUrl?: string;
  /** Polling interval in seconds (default: 300). */
  intervalSeconds?: number;
  /** Request timeout in milliseconds (default: 30 000). */
  timeoutMs?: number;
  /**
   * How many times the probe retries a connection-level failure before
   * recording a distribution as unavailable (default: the probe’s own
   * default). Set to `0` to disable retries.
   */
  retries?: number;
  /** Monitor definitions. */
  monitors: RawMonitorConfig[];
}

/**
 * Type helper for TypeScript config files.
 *
 * @example
 * ```ts
 * // distribution-monitor.config.ts
 * import { defineConfig } from '@lde/distribution-monitor';
 *
 * export default defineConfig({
 *   databaseUrl: process.env.DATABASE_URL,
 *   intervalSeconds: 300,
 *   monitors: [
 *     {
 *       identifier: 'dbpedia',
 *       distribution: {
 *         accessUrl: 'https://dbpedia.org/sparql',
 *         conformsTo: 'https://www.w3.org/TR/sparql11-protocol/',
 *       },
 *       sparqlQuery: 'ASK { ?s ?p ?o }',
 *     },
 *     {
 *       identifier: 'my-dump',
 *       distribution: {
 *         accessUrl: 'https://example.org/data.nt',
 *         mediaType: 'application/n-triples',
 *       },
 *     },
 *   ],
 * });
 * ```
 */
export function defineConfig(
  config: DistributionMonitorConfig,
): DistributionMonitorConfig {
  return config;
}

/**
 * Normalize config: convert string URLs to URL objects and construct
 * {@link Distribution} instances for each monitor.
 */
export function normalizeConfig(raw: DistributionMonitorConfig): {
  databaseUrl?: string;
  intervalSeconds?: number;
  timeoutMs?: number;
  retries?: number;
  monitors: MonitorConfig[];
} {
  return {
    databaseUrl: raw.databaseUrl,
    intervalSeconds: raw.intervalSeconds,
    timeoutMs: raw.timeoutMs,
    retries: raw.retries,
    monitors: raw.monitors.map((m) => ({
      identifier: m.identifier,
      distribution: toDistribution(m.distribution),
      sparqlQuery: m.sparqlQuery,
    })),
  };
}

function toDistribution(raw: RawMonitorConfig['distribution']): Distribution {
  const accessUrl =
    typeof raw.accessUrl === 'string' ? new URL(raw.accessUrl) : raw.accessUrl;
  const conformsTo =
    raw.conformsTo === undefined
      ? undefined
      : typeof raw.conformsTo === 'string'
        ? new URL(raw.conformsTo)
        : raw.conformsTo;
  return new Distribution(accessUrl, raw.mediaType, conformsTo);
}
