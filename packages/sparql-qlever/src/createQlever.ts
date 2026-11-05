import { DockerTaskRunner } from '@lde/task-runner-docker';
import { HttpTaskRunner } from '@lde/task-runner-http';
import { NativeTaskRunner } from '@lde/task-runner-native';
import { TaskRunner } from '@lde/task-runner';
import {
  Downloader,
  LastModifiedDownloader,
} from '@lde/distribution-downloader';
import {
  Importer,
  QleverImporterOptions,
  QleverIndexOptions,
} from './importer.js';
import { QleverServerOptions, Server } from './server.js';

export type QleverOptions = {
  /** Directory where downloaded data files are stored. */
  dataDir?: string;
  indexName?: string;
  /** @default 7001 */
  port?: number;
  downloader?: Downloader;
  /** Cache QLever indices and skip re-indexing when source data is unchanged. @default true */
  cacheIndex?: boolean;
  /** Options for `qlever-index` (index building). */
  indexOptions?: QleverIndexOptions;
  /** See {@link QleverImporterOptions.replaceJsonLdContext}. */
  replaceJsonLdContext?: QleverImporterOptions['replaceJsonLdContext'];
  /** Options for `qlever-server` (query processing). */
  serverOptions?: QleverServerOptions;
} & (
  | {
      mode: 'docker';
      image: string;
      containerName?: string;
      network?: never;
    }
  | {
      mode: 'docker';
      image: string;
      /**
       * Docker network to attach the QLever containers to. Set this when the
       * consumer itself runs in a container on that network: the query
       * endpoint is then addressed by `containerName` as hostname instead of
       * a host-published `localhost` port, which a containerized consumer on
       * a bridge network cannot reach. Leave unset when the consumer runs on
       * the host (or shares the QLever container’s network namespace), where
       * `localhost` is correct.
       */
      network: string;
      /** The hostname at which consumers on the network reach the endpoint. */
      containerName: string;
    }
  | { mode: 'native' }
  | {
      /**
       * Run QLever in another container of the same pod, such as a sidecar
       * with its own memory limit, through the task agent of
       * `@lde/task-runner-http`. Both containers mount `dataDir` at the same
       * path.
       */
      mode: 'remote';
      /** Absolute, and the same path in both containers. */
      dataDir: string;
    }
);

/**
 * Create a paired QLever {@link Importer} and {@link Server} that share a
 * single {@link TaskRunner}. In pipeline setups the importer and server must
 * use the same runner (and therefore the same Docker container, sidecar or
 * working directory) so that the server can serve the index the importer built.
 */
export function createQlever(options: QleverOptions) {
  const port = options.port ?? 7001;
  // On a shared network the endpoint is reached by container name, so don't
  // claim a host port.
  const hostname =
    options.mode === 'docker' && options.network
      ? options.containerName
      : undefined;
  const taskRunner: TaskRunner<unknown> =
    options.mode === 'docker'
      ? new DockerTaskRunner({
          image: options.image,
          containerName: options.containerName,
          mountDir: options.dataDir,
          network: options.network,
          port: hostname ? undefined : port,
        })
      : options.mode === 'remote'
        ? new HttpTaskRunner({ cwd: options.dataDir })
        : new NativeTaskRunner({ cwd: options.dataDir });

  return {
    importer: new Importer({
      taskRunner,
      indexName: options.indexName,
      downloader:
        options.downloader ?? new LastModifiedDownloader(options.dataDir),
      cacheIndex: options.cacheIndex,
      qleverOptions: options.indexOptions,
      replaceJsonLdContext: options.replaceJsonLdContext,
    }),
    server: new Server({
      taskRunner,
      indexName: options.indexName ?? 'data',
      port,
      hostname,
      qleverOptions: options.serverOptions,
    }),
  };
}
