import { CronJob } from 'cron';
import {
  probe,
  NetworkError,
  type ProbeResultType,
  type ProbeOptions,
} from '@lde/distribution-probe';
import type { CheckResult, MonitorConfig, ObservationStore } from './types.js';

/**
 * Function signature for a probe. Matches `probe()` from
 * `@lde/distribution-probe`; injectable so tests can stub it.
 */
export type Probe = typeof probe;

export interface MonitorServiceOptions {
  /** Store for persisting observations. */
  store: ObservationStore;
  /** Monitor configurations. */
  monitors: MonitorConfig[];
  /** Polling interval in seconds (default: 300). */
  intervalSeconds?: number;
  /** Request timeout in milliseconds passed to the probe (default: 30 000). */
  timeoutMs?: number;
  /**
   * How many times the probe retries a connection-level failure before
   * recording the distribution as unavailable. Forwarded to
   * {@link probe}; when omitted, the probe’s own default applies.
   */
  retries?: number;
  /** HTTP headers forwarded to every probe request (e.g. User-Agent). */
  headers?: Headers;
  /**
   * Override the probe function. Mostly useful for tests; defaults to
   * {@link probe} from `@lde/distribution-probe`.
   */
  probe?: Probe;
}

const DEFAULT_TIMEOUT_MS = 30_000;

/**
 * Orchestrates monitoring of multiple DCAT distributions.
 */
export class MonitorService {
  private readonly store: ObservationStore;
  private readonly probe: Probe;
  private readonly configs: MonitorConfig[];
  private readonly intervalSeconds: number;
  private readonly timeoutMs: number;
  private readonly retries?: number;
  private readonly headers?: Headers;
  private job: CronJob | null = null;

  constructor(options: MonitorServiceOptions) {
    this.store = options.store;
    this.probe = options.probe ?? probe;
    this.configs = options.monitors;
    this.intervalSeconds = options.intervalSeconds ?? 300;
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.retries = options.retries;
    this.headers = options.headers;
  }

  /**
   * Perform an immediate check for a monitor.
   */
  async checkNow(identifier: string): Promise<void> {
    const config = this.configs.find((c) => c.identifier === identifier);
    if (!config) {
      throw new Error(`Monitor not found: ${identifier}`);
    }
    await this.performCheck(config);
  }

  /**
   * Perform an immediate check for all monitors.
   */
  async checkAll(): Promise<void> {
    await Promise.all(this.configs.map((config) => this.performCheck(config)));
  }

  /**
   * Start monitoring all configured distributions.
   */
  start(): void {
    if (!this.job) {
      const cronExpression = this.secondsToCron(this.intervalSeconds);
      this.job = new CronJob(cronExpression, () => this.checkAll());
      this.job.start();
    }
  }

  /**
   * Stop monitoring.
   */
  stop(): void {
    if (this.job) {
      this.job.stop();
      this.job = null;
    }
  }

  /**
   * Check whether monitoring is running.
   */
  isRunning(): boolean {
    return this.job !== null;
  }

  /**
   * Convert seconds to a cron expression.
   */
  private secondsToCron(seconds: number): string {
    if (seconds < 60) {
      return `*/${seconds} * * * * *`;
    }
    const minutes = Math.floor(seconds / 60);
    if (minutes < 60) {
      return `0 */${minutes} * * * *`;
    }
    const hours = Math.floor(minutes / 60);
    return `0 0 */${hours} * * *`;
  }

  private async performCheck(config: MonitorConfig): Promise<void> {
    const observedAt = new Date();
    const options: ProbeOptions = { timeoutMs: this.timeoutMs };
    if (this.retries !== undefined) options.retries = this.retries;
    if (this.headers) options.headers = this.headers;
    if (config.sparqlQuery) options.sparqlQuery = config.sparqlQuery;

    const result = await this.probe(config.distribution, options);
    const checkResult = mapProbeResult(result, observedAt);
    await this.store.store({ monitor: config.identifier, ...checkResult });
  }
}

/**
 * Collapse a {@link ProbeResultType} into a {@link CheckResult}. Network
 * errors become `success: false` with the network error message; HTTP or
 * body-validation failures become `success: false` with the probe's
 * failureReason (falling back to joined warnings or the HTTP status) as the
 * error message; everything else is `success: true`.
 */
export function mapProbeResult(
  result: ProbeResultType,
  observedAt: Date,
): CheckResult {
  if (result instanceof NetworkError) {
    return {
      success: false,
      responseTimeMs: result.responseTimeMs,
      errorMessage: result.message,
      observedAt,
    };
  }

  if (result.isSuccess()) {
    return {
      success: true,
      responseTimeMs: result.responseTimeMs,
      errorMessage: null,
      observedAt,
    };
  }

  const errorMessage =
    result.failureReason ??
    (result.warnings.length > 0
      ? result.warnings.join('; ')
      : `HTTP ${result.statusCode} ${result.statusText}`);

  return {
    success: false,
    responseTimeMs: result.responseTimeMs,
    errorMessage,
    observedAt,
  };
}
