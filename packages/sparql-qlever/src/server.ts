import { SparqlServer } from '@lde/sparql-server';
import { TaskRunner } from '@lde/task-runner';
import { waitForSparqlEndpointAvailable } from '@lde/wait-for-sparql';

export interface QleverServerOptions {
  /** Maximum memory for query processing and caching. @default '4G' */
  'memory-max-size'?: string;
  /** Default query timeout. @default '30s' */
  'default-query-timeout'?: string;
  /** Maximum cache size for query results. QLever default: '30G'. */
  'cache-max-size'?: string;
}

/** Options that have defaults and are always present in the command. */
type RequiredQleverServerOptions = Required<
  Pick<QleverServerOptions, 'memory-max-size' | 'default-query-timeout'>
>;

const defaultQleverServerOptions: RequiredQleverServerOptions = {
  'memory-max-size': '4G',
  'default-query-timeout': '30s',
};

export class Server<Task> implements SparqlServer {
  private readonly taskRunner: TaskRunner<Task>;
  private readonly indexName: string;
  private task?: Task;
  private readonly port: number;
  private readonly hostname: string;
  private readonly qleverOptions: RequiredQleverServerOptions &
    Pick<QleverServerOptions, 'cache-max-size'>;

  constructor({
    taskRunner,
    indexName,
    port,
    hostname,
    qleverOptions,
  }: Arguments<Task>) {
    this.taskRunner = taskRunner;
    this.indexName = indexName;
    this.port = port ?? 7001;
    this.hostname = hostname ?? 'localhost';
    this.qleverOptions = { ...defaultQleverServerOptions, ...qleverOptions };
  }

  public async start(): Promise<void> {
    // TODO prevent double starts.

    const args = [
      'qlever-server',
      `--index-basename ${this.indexName}`,
      `--memory-max-size ${this.qleverOptions['memory-max-size']}`,
      `--default-query-timeout ${this.qleverOptions['default-query-timeout']}`,
      `--port ${this.port}`,
    ];

    if (this.qleverOptions['cache-max-size'] !== undefined) {
      args.push(`--cache-max-size ${this.qleverOptions['cache-max-size']}`);
    }

    this.task = await this.taskRunner.run(args.join(' '));
    await waitForSparqlEndpointAvailable(this.queryEndpoint.toString());
  }

  public async stop(): Promise<void> {
    if (this.task) {
      await this.taskRunner.stop(this.task);
      this.task = undefined;
    }
  }

  public get queryEndpoint(): URL {
    return new URL(`http://${this.hostname}:${this.port}/sparql`);
  }
}

export interface Arguments<Task> {
  taskRunner: TaskRunner<Task>;
  indexName: string;
  /** @default 7001 */
  port?: number;
  /**
   * Hostname at which consumers reach the query endpoint. Defaults to
   * `localhost`, which is right whenever the server shares the consumer’s
   * network namespace: a native process, a host-published Docker port, or
   * QLever running inside the consumer’s own container.
   */
  hostname?: string;
  qleverOptions?: QleverServerOptions;
}
