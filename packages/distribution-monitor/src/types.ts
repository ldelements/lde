import { Distribution } from '@lde/dataset';

/**
 * Configuration for a single monitor.
 *
 * Monitors target any DCAT {@link Distribution}: a SPARQL endpoint (in which
 * case `sparqlQuery` is used for the probe) or a data dump (in which case
 * `sparqlQuery` is ignored and the distribution is fetched with HEAD/GET).
 */
export interface MonitorConfig {
  /** Unique identifier for this monitor. */
  identifier: string;
  /** The DCAT distribution to probe. */
  distribution: Distribution;
  /**
   * SPARQL query to run against the endpoint. Only meaningful when the
   * distribution is a SPARQL endpoint. Defaults to a minimal availability
   * probe (`SELECT * { ?s ?p ?o } LIMIT 1`).
   */
  sparqlQuery?: string;
}

/**
 * Result of a single check against a distribution.
 */
export interface CheckResult {
  /** Whether the distribution responded successfully. */
  success: boolean;
  /** Response time in milliseconds. */
  responseTimeMs: number;
  /** Error message if the check failed. */
  errorMessage: string | null;
  /** Timestamp when the response was received (UTC). */
  observedAt: Date;
}

/**
 * Observation record from the database.
 */
export interface Observation {
  id: string;
  monitor: string;
  observedAt: Date;
  success: boolean;
  responseTimeMs: number;
  errorMessage: string | null;
}

/**
 * Store interface for persisting observations.
 */
export interface ObservationStore {
  /**
   * Get the latest observation for each identifier.
   * Returns a map keyed by identifier.
   */
  getLatest(): Promise<Map<string, Observation>>;

  /**
   * Get a specific observation by ID.
   */
  get(id: string): Promise<Observation | null>;

  /**
   * Save a new observation. Also updates the latest-per-monitor record.
   */
  store(observation: Omit<Observation, 'id'>): Promise<Observation>;

  /**
   * Close the database connection.
   */
  close(): Promise<void>;
}
